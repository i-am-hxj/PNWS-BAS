/*
 * 应用外壳（App.view.xml）控制器
 * 职责：路由变化时同步浏览器标题，保证多个标签页能区分当前单据。
 */
sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/base/Log"
], function (Controller, Log) {
	"use strict";

	return Controller.extend("panawin.zinbound.controller.App", {

		/**
		 * @public
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

		onInit: function () {
			this._getRouter().attachRouteMatched(this._onRouteMatched, this);
		},

		/**
		 * 路由匹配后更新 document.title
		 * @param {sap.ui.base.Event} oEvent 路由事件
		 * @private
		 */
		_onRouteMatched: function (oEvent) {
			var sRouteName = oEvent.getParameter("name");
			var oArguments = oEvent.getParameter("arguments") || {};
			var sTitle = this._i18n("appTitle");

			if (sRouteName === "detail" && oArguments.inboundNo) {
				sTitle = this._i18n("detailPageTitle", [oArguments.inboundNo]);
			}

			try {
				document.title = sTitle;
			} catch (oError) {
				Log.warning("更新浏览器标题失败：" + (oError && oError.message));
			}
		},

		/**
		 * 取 i18n 文本
		 * @param {string} sKey 文本键
		 * @param {Array} [aArgs] 占位参数
		 * @returns {string} 文本
		 * @private
		 */
		_i18n: function (sKey, aArgs) {
			var oModel = this.getView().getModel("i18n");
			return oModel.getResourceBundle().getText(sKey, aArgs);
		}
	});
});
