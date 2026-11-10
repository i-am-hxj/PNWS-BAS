/*
 * 生产完工入库单管理 - 根组件
 *
 * 职责：
 *  1. 本地 Mock 模式（URL 参数 mock=true）下，先启动 localService/mockserver.js，
 *     再让 manifest 中声明的 ODataModel 发请求（MockServer 基于 sinon 拦截 XHR，必须提前启动）。
 *  2. 启动时一次性把 6 个值帮助集合 read() 进 JSONModel("vh")，供 sap.m.ComboBox 使用。
 *  3. 初始化路由。
 *
 * ★ 两条硬约束（本项目实测，勿改）：
 *   1) `UIComponent.prototype.init.apply(this, arguments)` **必须同步调用**。
 *      若推迟到异步回调（如 sap.ui.require 的 callback）里，UI5 会报
 *      "Mandatory init() not called for UIComponent" 并中止组件创建 → 整页空白。
 *   2) mockserver 依赖 sap/ui/core/util/MockServer → sap/ui/thirdparty/sinon.js，
 *      而 **SAPUI5 发行包不含 sinon.js**（只有 OpenUI5 有）。
 *      因此运行环境的 UI5 必须来自 CDN（OpenUI5）或其它带 sinon 的发行版；
 *      BAS 里把 index.html 的 src 换成本地 "/resources/sap-ui-core.js" 会导致
 *      sinon 404 → Component 创建失败 → 整页空白。
 *      （若将来必须支持无 sinon 的 SAPUI5，需要把 MockServer 换成自研 XHR 拦截层。）
 */
sap.ui.define([
	"sap/ui/core/UIComponent",
	"sap/base/Log",
	"sap/base/util/UriParameters",
	"panawin/zinbound/localService/mockserver"
], function (UIComponent, Log, UriParameters, MockServer) {
	"use strict";

	// 值帮助集合（只读），与后端实体集名称一致
	var VH_ENTITY_SETS = [
		"WorkCenterVH",
		"ProdLineVH",
		"TeamVH",
		"WarehouseVH",
		"StorageBinVH",
		"CoilTypeVH"
	];

	return UIComponent.extend("panawin.zinbound.Component", {

		metadata: {
			manifest: "json",
			interfaces: [
				"sap.ui.core.IAsyncContentCreation"
			]
		},

		/**
		 * 组件初始化
		 * @public
		 */
		init: function () {
			// (1) Mock 必须先于第一个 OData 请求启动
			if (this._isMockMode()) {
				MockServer.init();
				Log.info("已启动 MockServer（localService/mockserver.js）");
			}

			// (2) 基础初始化：按 manifest 创建默认 ODataModel 与 vh JSONModel
			//     必须同步调用基类 init（见文件头约束 1）
			UIComponent.prototype.init.apply(this, arguments);

			// (3) 值帮助：启动时一次性加载
			this._loadValueHelps();

			// (4) 路由
			this.getRouter().initialize();
		},

		/**
		 * 是否本地 Mock 模式：index.html?mock=true
		 * @returns {boolean} 是否 Mock 模式
		 * @private
		 */
		_isMockMode: function () {
			var oUriParameters = UriParameters.fromQuery(window.location.search);
			var sMock = oUriParameters.get("mock");
			return sMock === "true" || sMock === "1";
		},

		/**
		 * 启动时一次性加载全部值帮助集合到 JSONModel("vh")
		 * @private
		 */
		_loadValueHelps: function () {
			var oODataModel = this.getModel();
			var oVhModel = this.getModel("vh");

			if (!oODataModel || !oVhModel) {
				Log.error("ODataModel 或 vh JSONModel 未创建，值帮助无法加载");
				return;
			}

			VH_ENTITY_SETS.forEach(function (sEntitySet) {
				oODataModel.read("/" + sEntitySet, {
					success: function (oData) {
						oVhModel.setProperty("/" + sEntitySet, (oData && oData.results) || []);
					},
					error: function (oError) {
						// 值帮助加载失败不阻塞主流程，ComboBox 会退化为只显示编码
						oVhModel.setProperty("/" + sEntitySet, []);
						Log.warning("值帮助 " + sEntitySet + " 加载失败：" + (oError && oError.message));
					}
				});
			});
		},

		/**
		 * 销毁组件时同时停止 MockServer，避免 sinon 继续拦截 XHR
		 * @public
		 */
		destroy: function () {
			if (this._isMockMode()) {
				MockServer.destroy();
			}
			UIComponent.prototype.destroy.apply(this, arguments);
		}
	});
});
