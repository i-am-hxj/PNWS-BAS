/*
 * 本地 MockServer —— 仅在 index.html?mock=true 时由 Component.js 启动。
 *
 * 实现要点：
 *  1. 使用 sap.ui.core.util.MockServer：
 *       rootUri     = /sap/opu/odata/sap/ZSB_INBZB_O2/   （与 manifest 中 mainService.uri 一致）
 *       metadata    = localService/metadata.xml        （simulate 的第一个参数，内部按 URL 同步加载）
 *       mockdata    = localService/mockdata/*.json     （按实体集名称加载）
 *     MockServer 自带 GET / POST / MERGE / DELETE / $batch / $metadata 处理器，
 *     并且原生支持 $filter(substringof/startswith/eq...)、$orderby、$expand、$top/$skip。
 *     其中 $expand=to_Items 依赖 metadata 中的 Association + ReferentialConstraint +
 *     EntityContainer/AssociationSet（见 metadata.xml），并由 MockServer 的
 *     _enhanceWithMetadata 为每条记录补出 to_Items 的 __deferred 链接。
 *
 *  2. 后端"主键由服务端生成"的规则无法被默认 POST 处理器模拟（默认处理器只会回显请求体），
 *     因此追加一个自定义 POST 处理器：生成 IN+yyyyMMdd+4 位流水 的 InboundNo，
 *     补齐后端计算字段（TotalItems/TotalLength/TotalWeight/CreatedBy），再返回 201。
 *
 *  3. MockServer 默认的 GET 只回显 mockdata 里的合计值；真实后端是实时计算的。
 *     这里通过 attachAfter("GET", ..., "InboundHeader") 在响应发出前按明细重算合计，
 *     使 Mock 环境的"行项目数/合计长度/合计重量"与明细保持一致。
 *
 * 关于注册顺序（重要）：
 *   sinon 的 fakeServer 逆序匹配已注册的 response，返回真值的处理器会终止匹配。
 *   因此自定义处理器必须追加在 MockServer 默认处理器之后（concat 在末尾）。
 */
sap.ui.define([
	"sap/ui/core/util/MockServer",
	"sap/base/Log"
], function (MockServer, Log) {
	"use strict";

	var ROOT_URI = "/sap/opu/odata/sap/ZSB_INBZB_O2/";
	var METADATA_URL = "localService/metadata.xml";
	var MOCKDATA_BASE_URL = "localService/mockdata/";

	var ENTITY_SET_HEADER = "InboundHeader";
	var ENTITY_SET_ITEM = "InboundItem";

	var oMockServer = null;

	/* ------------------------------------------------------------------ 工具 */

	/**
	 * 左补零
	 * @param {number|string} vValue 值
	 * @param {int} iLength 目标长度
	 * @returns {string} 补零后的字符串
	 * @private
	 */
	function pad(vValue, iLength) {
		var sValue = String(vValue);
		while (sValue.length < iLength) {
			sValue = "0" + sValue;
		}
		return sValue;
	}

	/**
	 * 今天的 yyyyMMdd（本地时区、无分隔符）
	 * @returns {string} 日期字符串
	 * @private
	 */
	function today() {
		var oNow = new Date();
		return String(oNow.getFullYear()) + pad(oNow.getMonth() + 1, 2) + pad(oNow.getDate(), 2);
	}

	/**
	 * 按后端规则生成入库单号：IN + yyyyMMdd + 4 位流水
	 * @param {object[]} aHeaders 现有抬头
	 * @returns {string} 新的入库单号
	 * @private
	 */
	function createInboundNo(aHeaders) {
		var sPrefix = "IN" + today();
		var iMax = 0;

		(aHeaders || []).forEach(function (oHeader) {
			var sInboundNo = String((oHeader && oHeader.InboundNo) || "");
			if (sInboundNo.indexOf(sPrefix) === 0) {
				var iSeq = parseInt(sInboundNo.substring(sPrefix.length), 10);
				if (!isNaN(iSeq) && iSeq > iMax) {
					iMax = iSeq;
				}
			}
		});

		return sPrefix + pad(iMax + 1, 4);
	}

	/**
	 * 取本次要用的入库单号
	 *
	 * 前端现在会自己取号并随请求提交（util/NumberUtil.js），
	 * 因此这里**优先使用请求体里的单号**；只有当请求体没带时才按
	 * "当天最大流水 + 1" 兜底生成。这样 Mock 的行为与真实服务一致，
	 * 也能顺带验证前端取号的正确性。
	 * @param {string} sRequestedNo 请求体里的单号（可空）
	 * @param {object[]} aHeaders 现有抬头
	 * @returns {string} 最终使用的入库单号
	 * @private
	 */
	function resolveInboundNo(sRequestedNo, aHeaders) {
		var sNo = String(sRequestedNo || "");

		if (sNo) {
			return sNo;
		}
		return createInboundNo(aHeaders);
	}

	/**
	 * 数值格式化为 3 位小数的字符串（Edm.Decimal(15,3)）
	 * @param {*} vValue 值
	 * @returns {string} 形如 123.456 的字符串
	 * @private
	 */
	function decimal3(vValue) {
		var fValue = parseFloat(vValue);
		return isNaN(fValue) ? "0.000" : fValue.toFixed(3);
	}

	/**
	 * 拼实体 URI（与 MockServer._enhanceWithMetadata 生成的格式保持一致）
	 * @param {string} sEntitySet 实体集名称
	 * @param {string} sKeyPredicate 键谓词（已带引号）
	 * @returns {string} 实体 URI
	 * @private
	 */
	function entityUri(sEntitySet, sKeyPredicate) {
		return ROOT_URI + sEntitySet + "(" + sKeyPredicate + ")";
	}

	/**
	 * 抬头实体 URI
	 * @param {string} sInboundNo 入库单号
	 * @returns {string} 实体 URI
	 * @private
	 */
	function headerUri(sInboundNo) {
		return entityUri(ENTITY_SET_HEADER, "'" + sInboundNo + "'");
	}

	/**
	 * 发送 JSON 响应
	 * @param {object} oXhr sinon 的 FakeXMLHttpRequest
	 * @param {int} iStatus HTTP 状态码
	 * @param {object} oBody 响应体（会被 JSON.stringify）
	 * @param {object} [mHeaders] 附加响应头
	 * @private
	 */
	function respondJson(oXhr, iStatus, oBody, mHeaders) {
		var mAllHeaders = {
			"Content-Type": "application/json;charset=utf-8"
		};
		Object.keys(mHeaders || {}).forEach(function (sName) {
			mAllHeaders[sName] = mHeaders[sName];
		});
		oXhr.respond(iStatus, mAllHeaders, JSON.stringify(oBody));
	}

	/**
	 * 发送 OData V2 错误响应（前端 oError.message 可直接显示）
	 * @param {object} oXhr sinon 的 FakeXMLHttpRequest
	 * @param {int} iStatus HTTP 状态码
	 * @param {string} sMessage 错误信息
	 * @private
	 */
	function respondError(oXhr, iStatus, sMessage) {
		respondJson(oXhr, iStatus, {
			error: {
				code: String(iStatus),
				message: {
					lang: "zh",
					value: sMessage
				}
			}
		});
	}

	/* ------------------------------------------------ 后端计算字段（合计重算） */

	/**
	 * 依据明细重算抬头的 TotalItems / TotalLength / TotalWeight（模拟后端计算字段）
	 * @param {object[]} aHeaders 抬头（会被就地修改）
	 * @param {object[]} aItems 全部明细
	 * @private
	 */
	function recalculateTotals(aHeaders, aItems) {
		(aHeaders || []).forEach(function (oHeader) {
			var fTotalLength = 0;
			var fTotalWeight = 0;
			var iCount = 0;

			(aItems || []).forEach(function (oItem) {
				if (oItem.InboundNo !== oHeader.InboundNo) {
					return;
				}
				iCount++;
				fTotalLength += parseFloat(oItem.ActualLength) || 0;
				fTotalWeight += parseFloat(oItem.ActualWeight) || 0;
			});

			oHeader.TotalItems = iCount;
			oHeader.TotalLength = fTotalLength.toFixed(3);
			oHeader.TotalWeight = fTotalWeight.toFixed(3);
		});
	}

	/**
	 * GET 响应前挂载的 after 事件处理：集合请求带 oFilteredData，单实体请求带 oEntry
	 * @param {sap.ui.base.Event} oEvent MockServer 事件
	 * @private
	 */
	function onGetHeaderAfter(oEvent) {
		var aItems = oMockServer.getEntitySetData(ENTITY_SET_ITEM) || [];
		var oFilteredData = oEvent.getParameter("oFilteredData");
		var oEntry = oEvent.getParameter("oEntry");

		if (oFilteredData && oFilteredData.results) {
			recalculateTotals(oFilteredData.results, aItems);
		}

		if (oEntry) {
			if (oEntry.to_Items && oEntry.to_Items.results) {
				// 单实体 + $expand=to_Items：直接用已展开的明细重算
				recalculateTotals([oEntry], oEntry.to_Items.results);
			} else {
				recalculateTotals([oEntry], aItems);
			}
		}
	}

	/* ------------------------------------------------ 自定义 POST：创建抬头 */

	/**
	 * POST /InboundHeader 的自定义处理器
	 *
	 * 前端已自己取号（util/NumberUtil.js）并随请求提交，因此这里：
	 *   1. 优先使用请求体里的 InboundNo；
	 *   2. 若该单号已存在，返回 **409**（模拟真实服务的主键冲突），
	 *      让前端的"重新取号重试"逻辑得到验证；
	 *   3. 计算字段（合计/创建人）仍由"后端"写入。
	 * @param {object} oXhr sinon 的 FakeXMLHttpRequest
	 * @returns {boolean} 已处理
	 * @private
	 */
	function onCreateHeader(oXhr) {
		var oPayload;

		try {
			oPayload = JSON.parse(oXhr.requestBody || "{}");
		} catch (oError) {
			respondError(oXhr, 400, "请求体不是合法的 JSON");
			return true;
		}

		var aHeaders = oMockServer.getEntitySetData(ENTITY_SET_HEADER) || [];
		var sInboundNo = resolveInboundNo(oPayload.InboundNo, aHeaders);

		// 主键冲突：模拟真实服务的 MC_CSP_USR_RUNTIME/006
		var bExists = aHeaders.some(function (oRow) {
			return oRow && oRow.InboundNo === sInboundNo;
		});
		if (bExists) {
			respondError(oXhr, 409, "关键值已在使用中。请输入不同值。");
			return true;
		}

		var sUri = headerUri(sInboundNo);

		// 前端只提交可编辑字段；主键、计算字段、创建人一律由"后端"写入
		var oEntity = {
			InboundNo: sInboundNo,
			WorkOrder: oPayload.WorkOrder || "",
			WorkCenter: oPayload.WorkCenter || "",
			ProdLine: oPayload.ProdLine || "",
			Team: oPayload.Team || "",
			Warehouse: oPayload.Warehouse || "",
			MesNo: oPayload.MesNo || "",
			Remark: oPayload.Remark || "",
			TotalItems: 0,
			TotalLength: "0.000",
			TotalWeight: "0.000",
			CreatedBy: "MOCKUSER"
		};

		// 与 MockServer._enhanceWithMetadata 保持一致：补 __metadata 与 to_Items 的 __deferred
		// （to_Items 的 __deferred 是 $expand=to_Items 能工作的前提）
		oEntity.__metadata = {
			id: sUri,
			uri: sUri,
			type: "ZSB_INBZB_O2.InboundHeader"
		};
		oEntity.to_Items = {
			__deferred: {
				uri: sUri + "/to_Items"
			}
		};

		aHeaders.push(oEntity);
		oMockServer.setEntitySetData(ENTITY_SET_HEADER, aHeaders);

		Log.info("MockServer: 创建入库单 " + sInboundNo);

		respondJson(oXhr, 201, {
			d: oEntity,
			uri: sUri
		}, {
			"Location": sUri
		});

		return true;
	}

	/* -------------------------------------------------------------- 生命周期 */

	/**
	 * 启动 MockServer
	 * @returns {sap.ui.core.util.MockServer} MockServer 实例
	 * @public
	 */
	function init() {
		if (oMockServer && oMockServer.isStarted()) {
			return oMockServer;
		}

		oMockServer = new MockServer({
			rootUri: ROOT_URI
		});

		// 1) 加载元数据 + mockdata，并按元数据生成默认 CRUD/查询/$batch 处理器
		oMockServer.simulate(METADATA_URL, {
			sMockdataBaseUrl: MOCKDATA_BASE_URL,
			bGenerateMissingMockData: false
		});

		// 2) 追加自定义处理器（必须放在默认处理器之后：sinon 逆序匹配，后注册者优先）
		var aRequests = oMockServer.getRequests() || [];
		aRequests.push({
			method: "POST",
			path: new RegExp("InboundHeader/?(?:\\?.*)?"),
			response: onCreateHeader
		});
		oMockServer.setRequests(aRequests);

		// 3) 响应前重算合计（模拟后端计算字段）
		oMockServer.attachAfter("GET", onGetHeaderAfter, ENTITY_SET_HEADER);

		// 4) 启动（sinon 接管 XHR）
		oMockServer.start();

		return oMockServer;
	}

	/**
	 * 停止并销毁 MockServer
	 * @public
	 */
	function destroy() {
		if (oMockServer) {
			try {
				oMockServer.stop();
				oMockServer.destroy();
			} catch (oError) {
				Log.warning("MockServer 停止失败：" + (oError && oError.message));
			}
			oMockServer = null;
		}
	}

	return {
		init: init,
		destroy: destroy,

		/**
		 * 当前 MockServer 实例（调试用）
		 * @returns {sap.ui.core.util.MockServer} 实例
		 * @public
		 */
		getMockServer: function () {
			return oMockServer;
		}
	};
});
