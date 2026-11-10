/*
 * 明细页控制器：生产完工入库单的抬头 + 明细维护
 *
 * 数据流：
 *  - 读取：read("/InboundHeader('单号')", {$expand: "to_Items"})，写入 JSONModel("detail") 作为"工作表"，
 *          这样新增的行可以在保存前显示在表格里（OData 的 createEntry 不会自动插入 to_Items 绑定）。
 *          同时把 __metadata.etag 存到 header._etag / item._etag，供乐观锁使用。
 *  - 保存（全部进入批处理组 changes，最后一次性 submitChanges）：
 *      · 抬头修改：collect 变化字段后 oModel.update(headerPath, oChanged, {groupId, eTag})
 *      · 行修改  ：collect 变化字段后 oModel.update(itemPath,   oChanged, {groupId, eTag})
 *      · 行新增  ：oModel.createEntry("/InboundItem", {properties, groupId})
 *      · 行删除  ：oModel.remove(itemPath, {groupId, eTag: "*"})
 *    说明：$expand 出来的明细在 V2 模型缓存里没有独立的实体 key 路径，
 *    因此这里使用 V2 的"无上下文写接口"（update/remove + eTag），
 *    而不是对 key 路径做 setProperty —— 后者不会登记为脏实体，submitChanges 会静默丢改动。
 *  - 取消：resetChanges() 后返回列表页。
 */
sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/BindingMode",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/base/Log",
	"panawin/zinbound/util/Formatter",
	"panawin/zinbound/util/PrintUtil",
	"panawin/zinbound/util/TotalsUtil"
], function (Controller, BindingMode, JSONModel, MessageBox, MessageToast, Log, Formatter, PrintUtil, TotalsUtil) {
	"use strict";

	var GROUP_ID = "changes";
	var HEADER_ENTITY_SET = "/InboundHeader";
	var ITEM_ENTITY_SET = "/InboundItem";

	// 行号步长与位数（后端约定：000010、000020 ...）
	var ITEM_NO_STEP = 10;
	var ITEM_NO_LENGTH = 6;

	// 抬头可编辑字段（InboundNo / 合计 / 创建人 只读）
	// 注：合计三个字段虽然只读显示，但**由前端计算后随抬头一起提交**，
	//     服务端 determination 不可用（见 TotalsUtil.js 顶部说明）
	var HEADER_EDITABLE_FIELDS = ["WorkOrder", "WorkCenter", "ProdLine", "Team", "Warehouse", "MesNo", "Remark"];
	var HEADER_READONLY_FIELDS = ["InboundNo", "CreatedBy", "TotalItems", "TotalLength", "TotalWeight"];

	// 合计字段（由 TotalsUtil.computeTotals 计算，随抬头 MERGE 提交）
	var HEADER_TOTAL_FIELDS = ["TotalItems", "TotalLength", "TotalWeight"];

	// 明细可编辑字段
	var ITEM_FIELDS = ["Material", "CoilType", "CoilNo", "BatchNo", "SerialNo", "ActualLength", "ActualWeight", "StorageBin"];
	var ITEM_DECIMAL_FIELDS = ["ActualLength", "ActualWeight"];

	return Controller.extend("panawin.zinbound.controller.Detail", {

		// 供 XML 视图使用：formatter=".formatter.formatXxx"
		formatter: Formatter,

		/* ==================================================================
		 * 生命周期
		 * ================================================================== */

		/**
		 * @public
		 */
		onInit: function () {
			this._iBusyCount = 0;
			this._sLastErrorMessage = null;
			this._iLastErrorTime = 0;

			this._oDetailModel = new JSONModel({
				header: {},
				originalHeader: {},
				items: [],
				deletedItems: []
			});
			// JSONModel 默认 OneWay，这里显式声明为双向，编辑结果才能写回工作表
			this._oDetailModel.setDefaultBindingMode(BindingMode.TwoWay);
			this.getView().setModel(this._oDetailModel, "detail");

			this._getRouter().getRoute("detail").attachPatternMatched(this._onPatternMatched, this);

			this._attachBusyIndicators();
		},

		/**
		 * @public
		 */
		onExit: function () {
			this._detachBusyIndicators();

			if (this._oDetailModel) {
				this._oDetailModel.destroy();
				this._oDetailModel = null;
			}
		},

		/**
		 * 路由参数匹配
		 * @param {sap.ui.base.Event} oEvent 路由事件
		 * @private
		 */
		_onPatternMatched: function (oEvent) {
			var oArguments = oEvent.getParameter("arguments") || {};

			this._sInboundNo = oArguments.inboundNo;
			if (this._sInboundNo) {
				this._loadDetail(this._sInboundNo);
			}
		},

		/* ==================================================================
		 * 基础帮助方法
		 * ================================================================== */

		/**
		 * 默认模型（OData V2）
		 * @returns {sap.ui.model.odata.v2.ODataModel} 模型
		 * @private
		 */
		_getModel: function () {
			return this.getView().getModel();
		},

		/**
		 * 工作表模型的根数据
		 * @returns {object} 数据
		 * @private
		 */
		_getData: function () {
			return this._oDetailModel.getData() || {};
		},

		/**
		 * 取 i18n 文本
		 * @param {string} sKey 文本键
		 * @param {Array} [aArgs] 占位参数
		 * @returns {string} 文本
		 * @private
		 */
		/**
		 * 取路由器
		 *
		 * 注意：sap.ui.core.mvc.Controller **没有** getRouter() 方法
		 * （UI5 1.120 实测：该方法只在 UIComponent 与 Router 上存在），
		 * 直接 this.getRouter() 会抛 "this.getRouter is not a function"，
		 * 导致 onInit 中断、页面空白。必须经 ownerComponent 取。
		 * @returns {sap.ui.core.routing.Router|null} 路由器；取不到时为 null
		 * @private
		 */
		_getRouter: function () {
			var oComponent = this.getOwnerComponent ? this.getOwnerComponent() : null;
			if (!oComponent || typeof oComponent.getRouter !== "function") {
				Log.warning("ownerComponent 无 getRouter，导航不可用");
				return null;
			}
			return oComponent.getRouter();
		},

		_i18n: function (sKey, aArgs) {
			var oModel = this.getView().getModel("i18n");
			// 防御：i18n 模型缺失时不要抛异常（否则 onInit 中断 → 整页空白）
			if (!oModel) {
				Log.warning("i18n 模型未定义，回退显示文本键：" + sKey);
				return sKey;
			}
			return oModel.getResourceBundle().getText(sKey, aArgs);
		},

		/**
		 * 统一错误提示（1.5 秒内相同错误只弹一次）
		 * @param {object} oError 错误对象
		 * @private
		 */
		_showError: function (oError) {
			var sMessage = (oError && oError.message) || this._i18n("msgUnknownError");
			var iNow = Date.now();

			if (sMessage === this._sLastErrorMessage && iNow - this._iLastErrorTime < 1500) {
				return;
			}
			this._sLastErrorMessage = sMessage;
			this._iLastErrorTime = iNow;

			Log.error(sMessage);
			MessageBox.error(sMessage, {
				title: this._i18n("errorTitle")
			});
		},

		/**
		 * busy 计数 +1
		 * @private
		 */
		_pushBusy: function () {
			this._iBusyCount++;
			this.getView().setBusy(true);
		},

		/**
		 * busy 计数 -1
		 * @private
		 */
		_popBusy: function () {
			this._iBusyCount = Math.max(0, this._iBusyCount - 1);
			if (this._iBusyCount === 0) {
				this.getView().setBusy(false);
			}
		},

		/**
		 * 监听 OData 请求，自动显示 busy 与后端错误
		 * @private
		 */
		_attachBusyIndicators: function () {
			var oModel = this._getModel();
			if (!oModel) {
				return;
			}
			oModel.attachRequestSent(this._onRequestSent, this);
			oModel.attachRequestCompleted(this._onRequestCompleted, this);
			oModel.attachRequestFailed(this._onRequestFailed, this);
			oModel.attachBatchRequestSent(this._onRequestSent, this);
			oModel.attachBatchRequestCompleted(this._onRequestCompleted, this);
			oModel.attachBatchRequestFailed(this._onRequestFailed, this);
		},

		/**
		 * 取消监听
		 * @private
		 */
		_detachBusyIndicators: function () {
			var oModel = this._getModel();
			if (!oModel) {
				return;
			}
			oModel.detachRequestSent(this._onRequestSent, this);
			oModel.detachRequestCompleted(this._onRequestCompleted, this);
			oModel.detachRequestFailed(this._onRequestFailed, this);
			oModel.detachBatchRequestSent(this._onRequestSent, this);
			oModel.detachBatchRequestCompleted(this._onRequestCompleted, this);
			oModel.detachBatchRequestFailed(this._onRequestFailed, this);
		},

		/**
		 * @param {sap.ui.base.Event} oEvent 请求发送事件
		 * @private
		 */
		_onRequestSent: function (oEvent) {
			this._pushBusy();
		},

		/**
		 * @param {sap.ui.base.Event} oEvent 请求完成事件
		 * @private
		 */
		_onRequestCompleted: function (oEvent) {
			this._popBusy();
		},

		/**
		 * 请求失败：只提示错误（busy 计数由 requestCompleted 回收）
		 * @param {sap.ui.base.Event} oEvent 请求失败事件
		 * @private
		 */
		_onRequestFailed: function (oEvent) {
			this._showError(oEvent.getParameter("error"));
		},

		/**
		 * 抬头实体路径
		 * @param {string} sInboundNo 入库单号
		 * @returns {string} 实体路径
		 * @private
		 */
		_headerPath: function (sInboundNo) {
			return HEADER_ENTITY_SET + "('" + sInboundNo + "')";
		},

		/**
		 * 明细实体路径（复合键，优先用模型的 createKey 保证键顺序与元数据一致）
		 * @param {string} sInboundNo 入库单号
		 * @param {string} sItemNo 行号
		 * @returns {string} 实体路径
		 * @private
		 */
		_itemPath: function (sInboundNo, sItemNo) {
			var oModel = this._getModel();

			try {
				if (oModel && typeof oModel.createKey === "function") {
					return oModel.createKey(ITEM_ENTITY_SET, {
						InboundNo: sInboundNo,
						ItemNo: sItemNo
					});
				}
			} catch (oError) {
				Log.warning("createKey 失败，使用手工拼接的键：" + (oError && oError.message));
			}

			return ITEM_ENTITY_SET + "(InboundNo='" + sInboundNo + "',ItemNo='" + sItemNo + "')";
		},

		/**
		 * 行号补足 6 位
		 * @param {int} iItemNo 行号数值
		 * @returns {string} 6 位行号
		 * @private
		 */
		_padItemNo: function (iItemNo) {
			var sItemNo = String(iItemNo);
			while (sItemNo.length < ITEM_NO_LENGTH) {
				sItemNo = "0" + sItemNo;
			}
			return sItemNo;
		},

		/**
		 * 值比较用的标准化（数值字段比较数值，其余比较去空格字符串）
		 * @param {string} sField 字段名
		 * @param {*} vValue 值
		 * @returns {string} 标准化结果
		 * @private
		 */
		_normalizeValue: function (sField, vValue) {
			if (ITEM_DECIMAL_FIELDS.indexOf(sField) !== -1) {
				var fValue = parseFloat(vValue);
				return isNaN(fValue) ? "" : fValue.toFixed(3);
			}
			if (vValue === null || vValue === undefined) {
				return "";
			}
			return String(vValue).trim();
		},

		/**
		 * 生成字段快照（用于判断是否被修改）
		 * @param {object} oObject 数据对象
		 * @param {string[]} aFields 字段
		 * @returns {object} 快照
		 * @private
		 */
		_snapshot: function (oObject, aFields) {
			var oSnapshot = {};

			aFields.forEach(function (sField) {
				var vValue = oObject ? oObject[sField] : undefined;
				oSnapshot[sField] = vValue === null || vValue === undefined ? "" : vValue;
			});

			return oSnapshot;
		},

		/* ==================================================================
		 * 读取
		 * ================================================================== */

		/**
		 * 读取单据（抬头 + 明细）到工作表模型
		 * @param {string} sInboundNo 入库单号
		 * @private
		 */
		_loadDetail: function (sInboundNo) {
			var oModel = this._getModel();
			var that = this;

			oModel.read(this._headerPath(sInboundNo), {
				urlParameters: {
					$expand: "to_Items"
				},
				success: function (oData) {
					that._fillModel(oData);
				},
				error: function (oError) {
					Log.error("读取入库单 " + sInboundNo + " 失败：" + (oError && oError.message));
					that._getRouter().navTo("list");
				}
			});
		},

		/**
		 * 把 OData 数据写入工作表模型
		 * （连同 __metadata.etag 一起保存，保存时用于 If-Match 乐观锁）
		 * @param {object} oData 抬头（包含 to_Items.results）
		 * @private
		 */
		_fillModel: function (oData) {
			var that = this;
			var oHeader = {};

			HEADER_EDITABLE_FIELDS.concat(HEADER_READONLY_FIELDS).forEach(function (sField) {
				var vValue = oData[sField];
				oHeader[sField] = vValue === null || vValue === undefined ? "" : vValue;
			});

			// 抬头的 ETag（Read 返回的 __metadata.etag）
			oHeader._etag = (oData.__metadata && oData.__metadata.etag) || null;

			var aItems = ((oData.to_Items && oData.to_Items.results) || []).map(function (oItem) {
				var oItemData = {
					InboundNo: oItem.InboundNo,
					ItemNo: String(oItem.ItemNo),
					_state: "clean",
					MaterialError: false,
					// 明细自己的 ETag（删除/修改时使用）
					_etag: (oItem.__metadata && oItem.__metadata.etag) || null
				};

				ITEM_FIELDS.forEach(function (sField) {
					var vValue = oItem[sField];
					oItemData[sField] = vValue === null || vValue === undefined ? "" : vValue;
				});

				// 只快照业务字段，etag/状态不参与"是否修改"的比较
				oItemData._original = that._snapshot(oItemData, ITEM_FIELDS);

				return oItemData;
			});

			// 按行号升序展示
			aItems.sort(function (oLeft, oRight) {
				return String(oLeft.ItemNo).localeCompare(String(oRight.ItemNo));
			});

			// 记录服务端已存的合计，保存时据此判断是否需要回写
			oHeader._storedTotals = {
				TotalItems: oHeader.TotalItems,
				TotalLength: oHeader.TotalLength,
				TotalWeight: oHeader.TotalWeight
			};

			this._oDetailModel.setData({
				header: oHeader,
				originalHeader: this._snapshot(oHeader, HEADER_EDITABLE_FIELDS),
				items: aItems,
				deletedItems: []
			});

			// 展示用合计按当前明细重算，保证界面自洽（不受历史存量值影响）
			this._refreshTotalsDisplay();
		},

		/**
		 * 按当前明细重算抬头合计并刷新展示
		 * @returns {{TotalItems: number, TotalLength: string, TotalWeight: string}} 合计
		 * @private
		 */
		_refreshTotalsDisplay: function () {
			var oData = this._getData();
			var oTotals = TotalsUtil.computeTotals(oData.items || []);

			this._oDetailModel.setProperty("/header/TotalItems", oTotals.TotalItems);
			this._oDetailModel.setProperty("/header/TotalLength", oTotals.TotalLength);
			this._oDetailModel.setProperty("/header/TotalWeight", oTotals.TotalWeight);

			return oTotals;
		},

		/* ==================================================================
		 * 明细行操作
		 * ================================================================== */

		/**
		 * 增加行：行号 = 当前最大数字行号 + 10
		 * @public
		 */
		onAddItem: function () {
			var oData = this._getData();
			var aItems = (oData.items || []).slice();
			var aDeleted = oData.deletedItems || [];
			var iMax = 0;

			// 已被删除但尚未提交的行也要参与计算，避免复用行号导致同一键的新增+删除冲突
			aItems.concat(aDeleted).forEach(function (oItem) {
				var iItemNo = parseInt(oItem.ItemNo, 10);
				if (!isNaN(iItemNo) && iItemNo > iMax) {
					iMax = iItemNo;
				}
			});

			var oNewItem = {
				InboundNo: this._sInboundNo,
				ItemNo: this._padItemNo(iMax + ITEM_NO_STEP),
				_state: "new",
				MaterialError: false
			};

			ITEM_FIELDS.forEach(function (sField) {
				oNewItem[sField] = "";
			});

			aItems.push(oNewItem);
			this._oDetailModel.setProperty("/items", aItems);
			this._refreshTotalsDisplay();
		},

		/**
		 * 删除行：新增行直接从工作表移除；已存在的行记入待删除列表，保存时 remove()
		 * @param {sap.ui.base.Event} oEvent 事件
		 * @public
		 */
		onDeleteItem: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext("detail");

			if (!oContext) {
				return;
			}

			var aPathParts = oContext.getPath().split("/");
			var iIndex = parseInt(aPathParts[aPathParts.length - 1], 10);
			var aItems = (this._getData().items || []).slice();

			if (isNaN(iIndex) || iIndex < 0 || iIndex >= aItems.length) {
				return;
			}

			var oRemoved = aItems.splice(iIndex, 1)[0];
			this._oDetailModel.setProperty("/items", aItems);

			if (oRemoved._state !== "new") {
				var aDeleted = (this._getData().deletedItems || []).slice();
				aDeleted.push({
					InboundNo: oRemoved.InboundNo,
					ItemNo: oRemoved.ItemNo
				});
				this._oDetailModel.setProperty("/deletedItems", aDeleted);
			}

			this._refreshTotalsDisplay();
		},

		/**
		 * 明细数值字段变更：即时重算抬头合计（长度/重量）
		 * @public
		 */
		onItemValueChange: function () {
			this._refreshTotalsDisplay();
		},

		/**
		 * 物料编码输入后清除必填错误状态
		 * @param {sap.ui.base.Event} oEvent 事件
		 * @public
		 */
		onItemMaterialChange: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext("detail");

			if (oContext) {
				oContext.setProperty("MaterialError", false);
			}
		},

		/* ==================================================================
		 * 保存 / 取消
		 * ================================================================== */

		/**
		 * 保存：update（抬头/行修改）+ createEntry（行新增）+ remove（行删除），
		 * 全部进入批处理组 changes，最后一次性 submitChanges
		 * @public
		 */
		onSave: function () {
			var oData = this._getData();
			var oHeader = oData.header || {};
			var aItems = oData.items || [];

			if (!this._validateHeader(oHeader)) {
				return;
			}
			if (!this._validateItems(aItems)) {
				return;
			}

			var oModel = this._getModel();
			var oOriginal = oData.originalHeader || {};
			var sHeaderPath = this._headerPath(this._sInboundNo);
			var that = this;

			// 1) 抬头：收集变化字段，一次 MERGE（带 ETag）
			var oChangedHeader = {};
			HEADER_EDITABLE_FIELDS.forEach(function (sField) {
				if (that._normalizeValue(sField, oHeader[sField]) !== that._normalizeValue(sField, oOriginal[sField])) {
					oChangedHeader[sField] = that._valueOf(oHeader[sField]);
				}
			});

			// 1.1) 合计：前端重算后随抬头一起提交
			//      （服务端 determination 不可用，字段已放开 readonly，见 TotalsUtil.js 说明）
			var oTotals = TotalsUtil.computeTotals(aItems);
			if (TotalsUtil.differs(oHeader._storedTotals, oTotals)) {
				HEADER_TOTAL_FIELDS.forEach(function (sField) {
					oChangedHeader[sField] = oTotals[sField];
				});
			}

			if (Object.keys(oChangedHeader).length > 0) {
				this._updateEntity(sHeaderPath, oChangedHeader, oHeader._etag);
			}

			// 2) 明细：新增 createEntry，修改 update
			aItems.forEach(function (oItem) {
				if (oItem._state === "new") {
					that._createItem(oItem);
				} else if (that._isItemChanged(oItem)) {
					that._updateItem(oItem);
				}
			});

			// 3) 明细：删除 remove
			(oData.deletedItems || []).forEach(function (oDeleted) {
				that._deleteItem(oDeleted.InboundNo, oDeleted.ItemNo);
			});

			// 4) 一次性提交批处理组 changes（抬头 MERGE + 明细 POST/MERGE/DELETE）
			oModel.submitChanges({
				groupId: GROUP_ID,
				success: function () {
					MessageToast.show(that._i18n("msgSaveSuccess"));
					that._loadDetail(that._sInboundNo);
				},
				error: function (oError) {
					// 必须把错误弹出来：$batch 外层固定返回 202，
					// 子请求的真实错误只在响应体里，静默丢弃会让用户以为"保存成功但没数据"
					Log.error("保存入库单失败：" + (oError && oError.message));
					that._showError(oError);
				}
			});
		},

		/**
		 * 取消：丢弃未提交变更并返回列表
		 * @public
		 */
		onCancel: function () {
			MessageBox.confirm(this._i18n("msgCancelConfirm"), {
				title: this._i18n("confirmTitle"),
				onClose: function (sAction) {
					if (sAction === MessageBox.Action.OK) {
						this._getModel().resetChanges();
						this._getRouter().navTo("list");
					}
				}.bind(this)
			});
		},

		/**
		 * 返回列表
		 * @public
		 */
		onNavBack: function () {
			MessageBox.confirm(this._i18n("msgLeaveConfirm"), {
				title: this._i18n("confirmTitle"),
				onClose: function (sAction) {
					if (sAction === MessageBox.Action.OK) {
						this._getModel().resetChanges();
						this._getRouter().navTo("list");
					}
				}.bind(this)
			});
		},

		/**
		 * 取字段值（null/undefined -> ""）
		 * @param {*} vValue 值
		 * @returns {string} 值
		 * @private
		 */
		_valueOf: function (vValue) {
			return vValue === null || vValue === undefined ? "" : vValue;
		},

		/**
		 * 抬头必填校验
		 * @param {object} oHeader 抬头数据
		 * @returns {boolean} 是否通过
		 * @private
		 */
		_validateHeader: function (oHeader) {
			if (!oHeader.WorkOrder || !String(oHeader.WorkOrder).trim()) {
				MessageBox.error(this._i18n("msgWorkOrderRequired"), {
					title: this._i18n("msgRequiredTitle")
				});
				this.byId("inpWorkOrder").focus();
				return false;
			}

			if (!oHeader.Warehouse) {
				MessageBox.error(this._i18n("msgWarehouseRequired"), {
					title: this._i18n("msgRequiredTitle")
				});
				this.byId("cbWarehouse").focus();
				return false;
			}

			return true;
		},

		/**
		 * 明细校验：物料编码必填 + 长度/重量必须是数字
		 * @param {object[]} aItems 明细
		 * @returns {boolean} 是否通过
		 * @private
		 */
		_validateItems: function (aItems) {
			var aProblems = [];
			var that = this;

			if (aItems.length === 0) {
				MessageBox.error(this._i18n("msgItemsRequired"), {
					title: this._i18n("msgRequiredTitle")
				});
				return false;
			}

			aItems.forEach(function (oItem, iIndex) {
				var iRowNumber = iIndex + 1;
				var bMaterialMissing = !oItem.Material || !String(oItem.Material).trim();

				that._oDetailModel.setProperty("/items/" + iIndex + "/MaterialError", bMaterialMissing);
				if (bMaterialMissing) {
					aProblems.push(that._i18n("msgMaterialRequired", [String(iRowNumber)]));
				}

				ITEM_DECIMAL_FIELDS.forEach(function (sField) {
					var vValue = oItem[sField];
					if (vValue === null || vValue === undefined || String(vValue).trim() === "") {
						return;
					}
					if (isNaN(parseFloat(vValue)) || !/^-?\d+(\.\d+)?$/.test(String(vValue).trim())) {
						var sFieldLabel = that._i18n(sField === "ActualLength" ? "lblActualLength" : "lblActualWeight");
						aProblems.push(that._i18n("msgNumberInvalid", [String(iRowNumber), sFieldLabel]));
					}
				});
			});

			if (aProblems.length > 0) {
				MessageBox.error(aProblems.join("\n"), {
					title: this._i18n("msgRequiredTitle")
				});
				return false;
			}

			return true;
		},

		/**
		 * 判断已存在的行是否被修改
		 * @param {object} oItem 行数据
		 * @returns {boolean} 是否修改
		 * @private
		 */
		_isItemChanged: function (oItem) {
			var oOriginal = oItem._original || {};
			var that = this;
			var bChanged = false;

			ITEM_FIELDS.forEach(function (sField) {
				if (that._normalizeValue(sField, oItem[sField]) !== that._normalizeValue(sField, oOriginal[sField])) {
					bChanged = true;
				}
			});

			return bChanged;
		},

		/**
		 * 新增明细：createEntry("/InboundItem", ...)
		 * @param {object} oItem 行数据
		 * @private
		 */
		/**
		 * 新增明细：**必须经父导航创建**
		 *
		 * 明细是组合子实体（composition child），真实服务禁止独立创建：
		 *   POST /InboundItem                    → 405 CX_SADL_ENTITY_CUD_DISABLED
		 *   POST /InboundHeader('单号')/to_Items → 201 ✅（本项目实测）
		 *
		 * 注意：更新（MERGE）与删除（DELETE）**不受此限制**，
		 * 仍可直接对 /InboundItem(...) 操作（实测 204）。
		 *
		 * @param {object} oItem 行数据
		 * @private
		 */
		_createItem: function (oItem) {
			var oProperties = {
				InboundNo: oItem.InboundNo,
				ItemNo: oItem.ItemNo
			};

			ITEM_FIELDS.forEach(function (sField) {
				oProperties[sField] = oItem[sField] === null || oItem[sField] === undefined ? "" : oItem[sField];
			});

			// 组合子实体：经父实体的导航属性创建
			this._getModel().create(
				this._headerPath(oItem.InboundNo) + "/to_Items",
				oProperties,
				{ groupId: GROUP_ID }
			);
		},

		/**
		 * 统一的实体修改入口：V2 的 update（MERGE）并指定批处理组与 ETag
		 * @param {string} sPath 实体路径
		 * @param {object} oChanged 变化的字段
		 * @param {string} [sETag] ETag（缺失时退化为 "*"，即"后写覆盖"）
		 * @private
		 */
		_updateEntity: function (sPath, oChanged, sETag) {
			this._getModel().update(sPath, oChanged, {
				groupId: GROUP_ID,
				eTag: sETag || "*"
			});
		},

		/**
		 * 修改明细：收集变化字段后一次 MERGE（带 ETag）
		 * @param {object} oItem 行数据
		 * @private
		 */
		_updateItem: function (oItem) {
			var sItemPath = this._itemPath(oItem.InboundNo, oItem.ItemNo);
			var oOriginal = oItem._original || {};
			var oChanged = {};
			var that = this;

			ITEM_FIELDS.forEach(function (sField) {
				if (that._normalizeValue(sField, oItem[sField]) !== that._normalizeValue(sField, oOriginal[sField])) {
					oChanged[sField] = that._valueOf(oItem[sField]);
				}
			});

			if (Object.keys(oChanged).length > 0) {
				this._updateEntity(sItemPath, oChanged, oItem._etag);
			}
		},

		/**
		 * 删除明细：V2 的无上下文删除接口（remove + ETag）
		 * @param {string} sInboundNo 入库单号
		 * @param {string} sItemNo 行号
		 * @private
		 */
		_deleteItem: function (sInboundNo, sItemNo) {
			this._getModel().remove(this._itemPath(sInboundNo, sItemNo), {
				groupId: GROUP_ID,
				eTag: "*"
			});
		},

		/* ==================================================================
		 * 打印
		 * ================================================================== */

		/**
		 * 打印当前单据（用工作表中的数据，未保存的修改也会被打印）
		 * @public
		 */
		onPrint: function () {
			var oData = this._getData();
			var oHeader = oData.header || {};

			if (!oHeader.InboundNo) {
				MessageBox.error(this._i18n("msgNoDocument"), {
					title: this._i18n("errorTitle")
				});
				return;
			}

			var oVhModel = this.getView().getModel("vh");
			var oVhData = oVhModel ? oVhModel.getData() || {} : {};

			PrintUtil.print(oHeader, oData.items || [], Formatter.buildVhTexts(oHeader, oVhData));
		}
	});
});
