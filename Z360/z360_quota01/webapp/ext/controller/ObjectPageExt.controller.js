sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/model/json/JSONModel"
], function (Controller, ControllerExtension, JSONModel) {
    "use strict";

    return {

        onInit: function () {
            // 1. 本地 JSON 模型承载字段清单（表格只绑它，框架不再干预）
            this.getView().setModel(new JSONModel({ Fields: [] }), "fields");

            // 2. 每次进入对象页（实例切换）都重新创建字段清单，不复用旧对象
            this.extensionAPI.attachPageDataLoaded(function (oEvent) {
                var oContext = (oEvent.getParameter && oEvent.getParameter("context")) || oEvent.context;
                if (!oContext) { return; }
                var sTableName = oContext.getObject("dbnam");
                if (sTableName) {
                    this._loadFields(sTableName);
                }
            }.bind(this));
        },

        // ============================================================
        // 每次进入都创建新的字段清单：read 拉最新数据 + setData 新建
        // ============================================================
        _loadFields: function (sTableName) {
            var self = this;
            this._sLastTable = sTableName;

            var sPath = "/ZI_RetrieveTableFields(P_TableName='" + sTableName + "')/Set";
            this.getView().getModel().read(sPath, {
                success: function (oData) {
                    self.getView().getModel("fields").setData({
                        Fields: (oData && oData.results) || []
                    });
                },
                error: function (oError) {
                    sap.m.MessageToast.show("字段清单加载失败: " + sTableName);
                }
            });
        },

        // --- Helper Function to append text ---
        _appendToRulesTextArea: function (sNewText) {
            var oTextArea = this.getView().byId("excludeRulesTextArea");
            if (oTextArea) {
                var sCurrentValue = oTextArea.getValue() || "";
                // 自动处理空格，避免符号连在一起
                var sUpdatedValue = sCurrentValue.trim() === "" ? sNewText : sCurrentValue.trim() + " " + sNewText;
                oTextArea.setValue(sUpdatedValue);
            }
        },

        // --- SECTION 1: Table Selection Change ---
        onFieldSelectionChange: function (oEvent) {
            var oSelectedItem = oEvent.getParameter("listItem");
            if (!oSelectedItem) return;

            // 注意：表格现在绑定在本地模型 fields 上
            var oContext = oSelectedItem.getBindingContext("fields");
            if (oContext) {
                var sFieldName = oContext.getProperty("FieldName");
                this._appendToRulesTextArea(sFieldName);
            }
        },

        // --- SECTION 2: Math Buttons ---
        // You can map multiple buttons to one function or separate them
        onMathEqual: function () { this._appendToRulesTextArea("="); },
        onMathLtGt: function () { this._appendToRulesTextArea("<>"); },
        onMathGt: function () { this._appendToRulesTextArea(">"); },
        onMathLt: function () { this._appendToRulesTextArea("<"); },
        onMathGte: function () { this._appendToRulesTextArea(">="); },
        onMathLte: function () { this._appendToRulesTextArea("<="); },
        onMathBracketsLeft: function () { this._appendToRulesTextArea("("); },
        onMathBracketsRight: function () { this._appendToRulesTextArea(")"); },
        onMathAnd: function () { this._appendToRulesTextArea("AND"); },
        onMathOr: function () { this._appendToRulesTextArea("OR"); },
        onMathNot: function () { this._appendToRulesTextArea("NOT"); },
        onMathCS: function () { this._appendToRulesTextArea("CS"); },

        onInsertConstant: function () {
            var oInput = this.getView().byId("idConstantInput");
            if (oInput) {
                var sValue = oInput.getValue().trim();

                if (sValue !== "") {
                    this._appendToRulesTextArea(sValue);
                    oInput.setValue("");
                } else {
                    sap.m.MessageToast.show("请输入常量内容");
                }
            }
        },

        // --- SECTION 3: Actions ---
        onFormReset: function () {
            var oTextArea = this.getView().byId("excludeRulesTextArea");
            if (oTextArea) {
                oTextArea.setValue("");
                sap.m.MessageToast.show("Rules cleared");
            }
        },

        onReturnLastChanges: function () {
            var oTextArea = this.getView().byId("excludeRulesTextArea");
            var sVal = oTextArea.getValue();
            if (sVal) {
                // Remove the last word/operator
                var aParts = sVal.trim().split(" ");
                aParts.pop();
                oTextArea.setValue(aParts.join(" "));
            }
        }

    };
});
