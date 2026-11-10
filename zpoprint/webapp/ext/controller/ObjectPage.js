sap.ui.define(["sap/ui/core/mvc/ControllerExtension",
    "sap/ui/core/BusyIndicator",
    "sap/m/MessageToast"],
    function (ControllerExtension, BusyIndicator, MessageToast) {
        "use strict";
        return ControllerExtension.extend("zpoprint.ext.controller.ObjectPage", {
            override: {
                onInit: function () {
                    // this.base.getExtensionAPI() 在这里可用
                }
            },

            // ObjectPage 头部"打印PDF"按钮：调 bound action printItem 渲染 PDF
            onPrintItem: async function (oBindingContext, aSelectedContexts) {
                var oContext = (aSelectedContexts && aSelectedContexts[0]) || oBindingContext;
                if (!oContext) {
                    MessageToast.show("未找到行项目上下文");
                    return;
                }

                // 防卡死遮罩：ADS 渲染是同步耗时操作
                BusyIndicator.show(0);
                try {
                    // OData V4 bound action 必须带服务命名空间
                    // （以 $metadata 的 Schema Namespace 为准：
                    //   com.sap.gateway.srvd.zui_purorditemreport.v0001）
                    var sServiceNamespace = "com.sap.gateway.srvd.zui_purorditemreport.v0001";
                    var oModel = oContext.getModel();
                    var oBinding = oModel.bindContext(
                        oContext.getPath() + "/" + sServiceNamespace + ".printItem(...)");
                    await oBinding.execute();

                    var oRes = oBinding.getBoundContext().getObject();
                    if (!oRes || !oRes.PdfBase64) {
                        MessageToast.show("未返回 PDF，请检查系统消息");
                        return;
                    }

                    // Base64 → Blob → 浏览器打开 PDF
                    var sBin = atob(oRes.PdfBase64);
                    var aBuf = new Uint8Array(sBin.length);
                    for (var i = 0; i < sBin.length; i++) {
                        aBuf[i] = sBin.charCodeAt(i);
                    }
                    var oBlob = new Blob([aBuf], { type: oRes.Mimetype || "application/pdf" });
                    window.open(URL.createObjectURL(oBlob));
                } catch (oError) {
                    MessageToast.show("打印失败: " + (oError && oError.message ? oError.message : "未知错误"));
                    console.error("Print Action Error: ", oError);
                } finally {
                    BusyIndicator.hide();
                }
            }
        });
    });
