/*
 * 列表页控制器：入库单查询 / 新建 / 删除 / 打印
 *
 * 关键约定：
 *  - InboundNo **由前端生成**（util/NumberUtil.js）：先查当天最大流水再 +1，
 *    随 createEntry 一起提交；服务端只做唯一性约束，冲突时自动重新取号重试。
 *    （原因：本系统的行为实现类装不进本地处理类，RAP determination 不可用，
 *      详见 docs/07 §2.3 与 docs/08 §4）
 *  - 新建时只 createEntry 抬头并单独 submitChanges，拿到单号后跳转到明细页
 *    （不在同一个 batch 里创建抬头+明细）。
 *  - 删除：先删明细、提交，再删抬头、提交（两次 submitChanges，顺序提交）。
 *  - 打印：列表页打印选中的单据；多张单据在同一个打印窗口中分页打印。
 */
sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/core/Fragment",
	"sap/ui/model/BindingMode",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/ui/model/Sorter",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/base/Log",
	"panawin/zinbound/util/Formatter",
	"panawin/zinbound/util/PrintUtil",
	"panawin/zinbound/util/NumberUtil"
], function (Controller, Fragment, BindingMode, Filter, FilterOperator, Sorter, JSONModel,
	MessageBox, MessageToast, Log, Formatter, PrintUtil, NumberUtil) {
	"use strict";

	var GROUP_ID = "changes";
	var HEADER_ENTITY_SET = "InboundHeader";
	var ITEM_ENTITY_SET = "InboundItem";

	// 关键词搜索覆盖的字段（后端用 $filter 的 substringof 实现）
	var SEARCH_FIELDS = [
		"InboundNo",
		"WorkOrder",
		"WorkCenter",
		"ProdLine",
		"Team",
		"Warehouse",
		"MesNo",
		"Remark",
		"CreatedBy"
	];

	// 输入停顿多久后触发搜索（毫秒）
	var SEARCH_DELAY = 400;

	return Controller.extend("panawin.zinbound.controller.List", {

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

			this._oCreateModel = new JSONModel(this._createEmptyCreateData());
			// JSONModel 默认 OneWay，这里显式声明为双向，便于对话框内直接绑定
			this._oCreateModel.setDefaultBindingMode(BindingMode.TwoWay);

			this.byId("sortField").setSelectedKey("InboundNo");
			this.byId("txtSelected").setText(this._i18n("selectedInfo"));

			this._attachBusyIndicators();
		},

		/**
		 * @public
		 */
		onExit: function () {
			this._detachBusyIndicators();

			if (this._oCreateDialog) {
				this._oCreateDialog.destroy();
				this._oCreateDialog = null;
			}
			if (this._oCreateModel) {
				this._oCreateModel.destroy();
				this._oCreateModel = null;
			}
			window.clearTimeout(this._iSearchTimer);
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
		 * 列表表格
		 * @returns {sap.m.Table} 表格
		 * @private
		 */
		_getTable: function () {
			return this.byId("inboundTable");
		},

		/**
		 * 表格的数据绑定
		 * @returns {sap.ui.model.odata.v2.ODataListBinding} 列表绑定
		 * @private
		 */
		_getListBinding: function () {
			var oTable = this._getTable();
			return oTable ? oTable.getBinding("items") : null;
		},

		/**
		 * 值帮助模型数据
		 * @returns {object} vh JSONModel 数据
		 * @private
		 */
		_getVhData: function () {
			var oVhModel = this.getView().getModel("vh");
			return oVhModel ? oVhModel.getData() || {} : {};
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
		 * 统一的错误提示（同一错误 1.5 秒内只弹一次，避免批量失败时弹窗堆叠）
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
		 * busy 计数 -1（归零后关闭 busy）
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
		 * 请求失败：只提示错误（busy 计数在 requestCompleted/batchRequestCompleted 里统一回收，
		 * 因为失败时 UI5 会先 fire requestCompleted、再 fire requestFailed）
		 * @param {sap.ui.base.Event} oEvent 请求失败事件
		 * @private
		 */
		_onRequestFailed: function (oEvent) {
			this._showError(oEvent.getParameter("error"));
		},

		/**
		 * 空白的新建对话框数据
		 * @returns {object} 数据
		 * @private
		 */
		_createEmptyCreateData: function () {
			return {
				WorkOrder: "",
				WorkCenter: "",
				ProdLine: "",
				Team: "",
				Warehouse: "",
				MesNo: "",
				Remark: ""
			};
		},

		/**
		 * 抬头实体路径
		 * @param {string} sInboundNo 入库单号
		 * @returns {string} 实体路径
		 * @private
		 */
		_headerPath: function (sInboundNo) {
			return "/" + HEADER_ENTITY_SET + "('" + sInboundNo + "')";
		},

		/**
		 * 明细实体路径（复合键 InboundNo + ItemNo）
		 * @param {string} sInboundNo 入库单号
		 * @param {string} sItemNo 行号
		 * @returns {string} 实体路径
		 * @private
		 */
		_itemPath: function (sInboundNo, sItemNo) {
			return "/" + ITEM_ENTITY_SET + "(InboundNo='" + sInboundNo + "',ItemNo='" + sItemNo + "')";
		},

		/**
		 * 提交批处理组 changes
		 * @returns {Promise} 提交结果
		 * @private
		 */
		_submitChanges: function () {
			var oModel = this._getModel();
			return new Promise(function (resolve, reject) {
				oModel.submitChanges({
					groupId: GROUP_ID,
					success: resolve,
					error: reject
				});
			});
		},

		/**
		 * 读取单据（抬头 + 明细）
		 * @param {string[]} aInboundNos 单号列表
		 * @returns {Promise} [{header, items}]
		 * @private
		 */
		_readDocuments: function (aInboundNos) {
			var oModel = this._getModel();
			var that = this;

			return Promise.all(aInboundNos.map(function (sInboundNo) {
				return new Promise(function (resolve, reject) {
					oModel.read(that._headerPath(sInboundNo), {
						urlParameters: {
							$expand: "to_Items"
						},
						success: function (oData) {
							resolve({
								header: oData,
								items: (oData.to_Items && oData.to_Items.results) || []
							});
						},
						error: reject
					});
				});
			}));
		},

		/**
		 * 刷新列表
		 * @private
		 */
		_refreshList: function () {
			var oBinding = this._getListBinding();
			if (oBinding) {
				oBinding.refresh(true);
			}
		},

		/* ==================================================================
		 * 查询 / 过滤 / 排序
		 * ================================================================== */

		/**
		 * 关键词搜索（回车 / 点击搜索图标）
		 * @param {sap.ui.base.Event} oEvent 事件
		 * @public
		 */
		onSearch: function (oEvent) {
			window.clearTimeout(this._iSearchTimer);
			this._applyFilter(oEvent.getParameter("query") || "");
		},

		/**
		 * 输入即搜索（带防抖）
		 * @param {sap.ui.base.Event} oEvent 事件
		 * @public
		 */
		onSearchLive: function (oEvent) {
			var sValue = oEvent.getParameter("newValue") || "";

			window.clearTimeout(this._iSearchTimer);
			this._iSearchTimer = window.setTimeout(function () {
				this._applyFilter(sValue);
			}.bind(this), SEARCH_DELAY);
		},

		/**
		 * 对多个字段做 substringof 的 OR 过滤（后端 $filter）
		 * @param {string} sQuery 关键词
		 * @private
		 */
		_applyFilter: function (sQuery) {
			var oBinding = this._getListBinding();
			if (!oBinding) {
				return;
			}

			var sTrimmed = (sQuery || "").trim();
			if (!sTrimmed) {
				oBinding.filter([]);
				return;
			}

			var aFilters = SEARCH_FIELDS.map(function (sField) {
				return new Filter(sField, FilterOperator.Contains, sTrimmed);
			});

			oBinding.filter(new Filter({
				filters: aFilters,
				and: false
			}));
		},

		/**
		 * 排序（字段 + 升降序）
		 * @public
		 */
		onSortChange: function () {
			var oBinding = this._getListBinding();
			if (!oBinding) {
				return;
			}

			var sField = this.byId("sortField").getSelectedKey();
			var bDescending = this.byId("sortDesc").getPressed();

			oBinding.sort(new Sorter(sField, bDescending));
		},

		/**
		 * 选中数量提示
		 * @public
		 */
		onSelectionChange: function () {
			var oTable = this._getTable();
			var iCount = oTable.getSelectedItems().length;
			var oText = this.byId("txtSelected");

			if (iCount > 0) {
				oText.setText(this._i18n("selectedInfoCount", [String(iCount)]));
			} else {
				oText.setText(this._i18n("selectedInfo"));
			}
		},

		/**
		 * 刷新按钮
		 * @public
		 */
		onRefresh: function () {
			this._getModel().resetChanges();
			this._refreshList();
			MessageToast.show(this._i18n("msgRefreshed"));
		},

		/**
		 * 点击入库单号进入明细页
		 * @param {sap.ui.base.Event} oEvent 事件
		 * @public
		 */
		onOpenDetail: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext();
			if (!oContext) {
				return;
			}

			var oObject = oContext.getObject();
			this._getRouter().navTo("detail", {
				inboundNo: oObject.InboundNo
			});
		},

		/* ==================================================================
		 * 新建：先建抬头，拿到后端生成的 InboundNo 后再进明细页
		 * ================================================================== */

		/**
		 * 打开新建对话框
		 * @public
		 */
		onCreate: function () {
			var oView = this.getView();

			this._oCreateModel.setData(this._createEmptyCreateData());

			if (this._oCreateDialog) {
				this._oCreateDialog.open();
				return;
			}

			Fragment.load({
				name: "panawin.zinbound.view.CreateDialog",
				controller: this
			}).then(function (oDialog) {
				this._oCreateDialog = oDialog;
				oView.addDependent(oDialog);
				oDialog.setModel(this._oCreateModel, "create");
				if (oView.getModel("vh")) {
					oDialog.setModel(oView.getModel("vh"), "vh");
				}
				if (oView.getModel("i18n")) {
					oDialog.setModel(oView.getModel("i18n"), "i18n");
				}
				oDialog.open();
			}.bind(this)).catch(function (oError) {
				this._showError(oError);
			}.bind(this));
		},

		/**
		 * 新建对话框：确认
		 *
		 * 单号由前端生成（见 util/NumberUtil.js 顶部说明）：
		 *   取号（查当天最大流水 +1）-> createEntry 带 InboundNo -> submitChanges
		 *   若服务端报主键冲突（并发抢号），重新取号重试，最多 3 次。
		 * @public
		 */
		onCreateConfirm: function () {
			var oData = this._oCreateModel.getData();

			if (!this._validateCreateData(oData)) {
				return;
			}

			if (this._oCreateDialog) {
				this._oCreateDialog.setBusy(true);
			}

			this._createWithFreshNumber(oData, 1);
		},

		/**
		 * 取号并创建抬头；主键冲突时重试
		 * @param {object} oData 新建对话框数据
		 * @param {number} iAttempt 当前是第几次尝试（从 1 开始）
		 * @private
		 */
		_createWithFreshNumber: function (oData, iAttempt) {
			var iMaxAttempt = 3;

			this._fetchNextInboundNo().then(function (sInboundNo) {

				if (!sInboundNo) {
					throw new Error(this._i18n("msgNoExhausted"));
				}

				return this._createHeaderWithNo(oData, sInboundNo).then(function () {
					return sInboundNo;
				});

			}.bind(this)).then(function (sInboundNo) {

				if (this._oCreateDialog) {
					this._oCreateDialog.setBusy(false);
					this._oCreateDialog.close();
				}
				this._refreshList();
				MessageToast.show(this._i18n("msgCreateSuccess", [sInboundNo]));
				this._getRouter().navTo("detail", {
					inboundNo: sInboundNo
				});

			}.bind(this)).catch(function (oError) {

				// 并发抢号：服务端主键冲突 -> 重新取号重试
				if (this._isDuplicateKeyError(oError) && iAttempt < iMaxAttempt) {
					Log.warning("单号冲突，第 " + iAttempt + " 次重试取号");
					this._createWithFreshNumber(oData, iAttempt + 1);
					return;
				}

				if (this._oCreateDialog) {
					this._oCreateDialog.setBusy(false);
				}
				Log.error("创建入库单失败：" + (oError && oError.message));
				MessageBox.error(oError && oError.message
					? oError.message
					: this._i18n("msgCreateFailed"));
			}.bind(this));
		},

		/**
		 * 查当天已有单号，算出下一个可用单号
		 * @returns {Promise<string>} 单号；当日号段用尽时为空串
		 * @private
		 */
		_fetchNextInboundNo: function () {
			var oModel = this._getModel();
			var sPrefix = NumberUtil.todayPrefix();

			return new Promise(function (resolve, reject) {
				oModel.read("/" + HEADER_ENTITY_SET, {
					filters: [new Filter("InboundNo", FilterOperator.StartsWith, sPrefix)],
					urlParameters: {
						"$select": "InboundNo"
					},
					success: function (oResult) {
						var aNos = (oResult.results || []).map(function (oRow) {
							return oRow.InboundNo;
						});
						resolve(NumberUtil.nextNo(aNos));
					},
					error: function (oError) {
						reject(oError || new Error("读取已有单号失败"));
					}
				});
			});
		},

		/**
		 * 用指定单号创建抬头并提交
		 * @param {object} oData 新建对话框数据
		 * @param {string} sInboundNo 入库单号
		 * @returns {Promise<void>} 提交成功后 resolve
		 * @private
		 */
		_createHeaderWithNo: function (oData, sInboundNo) {
			var oModel = this._getModel();

			return new Promise(function (resolve, reject) {
				var oContext = oModel.createEntry("/" + HEADER_ENTITY_SET, {
					properties: {
						InboundNo: sInboundNo,
						WorkOrder: oData.WorkOrder,
						WorkCenter: oData.WorkCenter,
						ProdLine: oData.ProdLine,
						Team: oData.Team,
						Warehouse: oData.Warehouse,
						MesNo: oData.MesNo,
						Remark: oData.Remark
					},
					groupId: GROUP_ID
				});

				oModel.submitChanges({
					groupId: GROUP_ID,
					success: function () {
						resolve();
					},
					error: function (oError) {
						// 丢弃失败的待提交条目，避免影响下一次重试
						try {
							oModel.deleteCreatedEntry(oContext);
						} catch (e) {
							oModel.resetChanges();
						}
						reject(oError || new Error("提交失败"));
					}
				});
			});
		},

		/**
		 * 判断错误是否为"主键冲突"（并发抢到同一个单号）
		 * @param {object} oError OData 错误对象
		 * @returns {boolean} 是否主键冲突
		 * @private
		 */
		_isDuplicateKeyError: function (oError) {
			if (!oError) {
				return false;
			}

			var aTexts = [oError.message];
			var oResponse = oError.response;
			if (oResponse) {
				aTexts.push(oResponse.statusCode);
				if (oResponse.body) {
					aTexts.push(oResponse.body);
					try {
						var oBody = JSON.parse(oResponse.body);
						if (oBody && oBody.error && oBody.error.message) {
							aTexts.push(oBody.error.message.value);
						}
					} catch (e) {
						// 忽略：body 不是 JSON
					}
				}
			}

			var bDuplicate = aTexts.some(function (vValue) {
				var sValue = String(vValue || "");
				return sValue.indexOf("关键值已在使用中") >= 0 ||
					sValue.indexOf("already in use") >= 0 ||
					sValue.indexOf("Duplicate") >= 0 ||
					sValue.indexOf("MC_CSP_USR_RUNTIME/006") >= 0 ||
					sValue === "409";
			});

			return bDuplicate;
		},

		/**
		 * 新建对话框：取消
		 * @public
		 */
		onCreateCancel: function () {
			if (this._oCreateDialog) {
				this._oCreateDialog.close();
			}
			// 丢弃未提交的 createEntry（如果有）
			this._getModel().resetChanges();
		},


		/**
		 * 新建对话框必填校验
		 * @param {object} oData 对话框数据
		 * @returns {boolean} 是否通过
		 * @private
		 */
		_validateCreateData: function (oData) {
			var aProblems = [];

			if (!oData.WorkOrder || !String(oData.WorkOrder).trim()) {
				aProblems.push(this._i18n("msgWorkOrderRequired"));
			}
			if (!oData.Warehouse) {
				aProblems.push(this._i18n("msgWarehouseRequired"));
			}

			if (aProblems.length > 0) {
				MessageBox.error(aProblems.join("\n"), {
					title: this._i18n("msgRequiredTitle")
				});
				return false;
			}

			return true;
		},

		/* ==================================================================
		 * 删除：先删明细，再删抬头
		 * ================================================================== */

		/**
		 * 删除选中的入库单
		 * @public
		 */
		onDelete: function () {
			var aContexts = this._getTable().getSelectedContexts();

			if (aContexts.length === 0) {
				MessageBox.information(this._i18n("msgSelectForDelete"), {
					title: this._i18n("infoTitle")
				});
				return;
			}

			var aInboundNos = aContexts.map(function (oContext) {
				return oContext.getObject().InboundNo;
			});

			MessageBox.confirm(this._i18n("msgDeleteConfirm", [String(aInboundNos.length)]), {
				title: this._i18n("confirmTitle"),
				onClose: function (sAction) {
					if (sAction === MessageBox.Action.OK) {
						this._deleteDocuments(aInboundNos);
					}
				}.bind(this)
			});
		},

		/**
		 * 顺序删除：明细 -> 抬头
		 * @param {string[]} aInboundNos 入库单号列表
		 * @private
		 */
		_deleteDocuments: function (aInboundNos) {
			var oModel = this._getModel();

			this._pushBusy();

			this._readDocuments(aInboundNos).then(function (aDocuments) {
				// 第 1 步：删除全部明细（显式 eTag："*" 表示不校验版本，MockServer 忽略 If-Match）
				aDocuments.forEach(function (oDocument) {
					oDocument.items.forEach(function (oItem) {
						oModel.remove(this._itemPath(oItem.InboundNo, oItem.ItemNo), {
							groupId: GROUP_ID,
							eTag: "*"
						});
					}, this);
				}, this);
				return this._submitChanges();
			}.bind(this)).then(function () {
				// 第 2 步：删除抬头
				aInboundNos.forEach(function (sInboundNo) {
					oModel.remove(this._headerPath(sInboundNo), {
						groupId: GROUP_ID,
						eTag: "*"
					});
				}, this);
				return this._submitChanges();
			}.bind(this)).then(function () {
				this._popBusy();
				MessageToast.show(this._i18n("msgDeleteSuccess"));
				this._refreshList();
			}.bind(this)).catch(function (oError) {
				this._popBusy();
				Log.error("删除入库单失败：" + (oError && oError.message));
				this._refreshList();
			}.bind(this));
		},

		/* ==================================================================
		 * 打印
		 * ================================================================== */

		/**
		 * 打印选中的单据（多张单据共用一个打印窗口）
		 * @public
		 */
		onPrint: function () {
			var aContexts = this._getTable().getSelectedContexts();

			if (aContexts.length === 0) {
				MessageBox.information(this._i18n("msgSelectForPrint"), {
					title: this._i18n("infoTitle")
				});
				return;
			}

			var aInboundNos = aContexts.map(function (oContext) {
				return oContext.getObject().InboundNo;
			});

			this._pushBusy();

			this._readDocuments(aInboundNos).then(function (aDocuments) {
				this._popBusy();

				var oVhData = this._getVhData();
				var aPrintable = aDocuments.map(function (oDocument) {
					return {
						header: oDocument.header,
						items: oDocument.items,
						texts: Formatter.buildVhTexts(oDocument.header, oVhData)
					};
				});

				PrintUtil.printMany(aPrintable);
			}.bind(this)).catch(function (oError) {
				this._popBusy();
				Log.error("打印取数失败：" + (oError && oError.message));
			}.bind(this));
		}
	});
});
