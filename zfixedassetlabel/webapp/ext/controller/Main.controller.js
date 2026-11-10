sap.ui.define(["sap/ui/core/mvc/ControllerExtension",
    "sap/ui/core/BusyIndicator",
    "sap/m/MessageToast"],
    function (ControllerExtension, BusyIndicator, MessageToast) {
        "use strict";
        return ControllerExtension.extend("zfixedassetlabel.ext.controller.Main", {
            override: {
                onInit: function () {
                    // this.base.getExtensionAPI() 在这里可用
                }
            },

            onPrintLabel: async function () {
                var oExAPI = this.base.getExtensionAPI();
                var aContexts = await oExAPI.getSelectedContexts();
                if (!aContexts || aContexts.length === 0) {
                    MessageToast.show("请先选中要打印的固定资产行");
                    return;
                }

                // 防卡死遮罩：ADS 渲染/合并是同步耗时操作
                BusyIndicator.show(0);
                try {
                    // 选中行 key 拼串：一次调用、后端合并成一个 PDF（每行一页）
                    var sKeys = aContexts.map(function (oCtx) {
                        var o = oCtx.getObject();
                        return o.CompanyCode + "|" + o.MasterFixedAsset + "|" + o.FixedAsset;
                    }).join(",");

                    // 用第一个 context 调 action（关键：只调一次，不逐行调）
                    // OData V4 bound action 必须带服务命名空间（以 $metadata 的
                    // Schema Namespace 为准，实测：com.sap.gateway.srvd.zsd_falabel.v0001）
                    var sServiceNamespace = "com.sap.gateway.srvd.zsd_falabel.v0001";
                    var oModel = aContexts[0].getModel();
                    var oBinding = oModel.bindContext(
                        aContexts[0].getPath() + "/" + sServiceNamespace + ".printLabel(...)");
                    oBinding.setParameter("AssetKeys", sKeys);
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
                    var oBlob = new Blob([aBuf], { type: oRes.MimeType });
                    window.open(URL.createObjectURL(oBlob));
                } catch (oError) {
                    //MessageToast.show("调用打印服务发生错误，请检查网络或控制台日志");
                    MessageToast.show("打印失败: " + (oError && oError.message ? oError.message : "未知错误"));
                    console.error("Print Action Error: ", oError);
                } finally {
                    BusyIndicator.hide();
                }
            }
        });
    });