/*
 * 通用格式化工具（供 XML 视图的 formatter 与 controller 复用）
 *
 * 视图中的用法：
 *   text="{path: 'TotalWeight', formatter: '.formatter.formatDecimal3'}"
 *   text="{parts: [{path: 'Warehouse'}, {path: 'vh>/WarehouseVH'}], formatter: '.formatter.formatVhText'}"
 */
sap.ui.define([], function () {
	"use strict";

	var EMPTY = "-";
	var ITEM_NO_LENGTH = 6;

	/**
	 * 是否空值（null / undefined / 空串 / 全空格）
	 * @param {*} vValue 值
	 * @returns {boolean} 是否空
	 * @private
	 */
	function isBlank(vValue) {
		return vValue === null || vValue === undefined || String(vValue).trim() === "";
	}

	/**
	 * 数值格式化为 3 位小数；空值或非数值显示 "-"
	 * @param {*} vValue 值（Edm.Decimal 从 OData 返回的是字符串）
	 * @returns {string} 格式化结果
	 * @public
	 */
	function formatDecimal3(vValue) {
		if (isBlank(vValue)) {
			return EMPTY;
		}
		var fValue = parseFloat(String(vValue).replace(/,/g, ""));
		if (isNaN(fValue)) {
			return EMPTY;
		}
		return fValue.toFixed(3);
	}

	/**
	 * 整数显示；空值显示 0
	 * @param {*} vValue 值
	 * @returns {string} 格式化结果
	 * @public
	 */
	function formatInteger(vValue) {
		if (isBlank(vValue)) {
			return "0";
		}
		return String(vValue);
	}

	/**
	 * 文本显示；空值显示 "-"
	 * @param {*} vValue 值
	 * @returns {string} 格式化结果
	 * @public
	 */
	function formatText(vValue) {
		return isBlank(vValue) ? EMPTY : String(vValue);
	}

	/**
	 * 行号补足 6 位（"10" -> "000010"）
	 * @param {*} vValue 行号
	 * @returns {string} 6 位行号
	 * @public
	 */
	function formatItemNo(vValue) {
		if (isBlank(vValue)) {
			return EMPTY;
		}
		var sValue = String(vValue);
		while (sValue.length < ITEM_NO_LENGTH) {
			sValue = "0" + sValue;
		}
		return sValue;
	}

	/**
	 * 值帮助：编码 -> 描述。找不到映射时回退为编码本身。
	 * 值帮助集合的结构为 [{WorkCenter: 'WC01', WorkCenterText: '冷轧一车间'}, ...]，
	 * 这里通过"非 *Text 属性等于编码"来定位条目，因此对 6 个值帮助集合通用。
	 * @param {string} sCode 编码
	 * @param {object[]} aVhList 值帮助集合（JSONModel("vh") 中的数组）
	 * @returns {string} 描述文本
	 * @public
	 */
	function formatVhText(sCode, aVhList) {
		if (isBlank(sCode)) {
			return EMPTY;
		}
		if (!Array.isArray(aVhList)) {
			return String(sCode);
		}

		var sText = null;
		aVhList.some(function (oEntry) {
			if (!oEntry) {
				return false;
			}
			return Object.keys(oEntry).some(function (sKey) {
				if (sKey === "__metadata" || /Text$/.test(sKey)) {
					return false;
				}
				if (String(oEntry[sKey]) !== String(sCode)) {
					return false;
				}
				sText = oEntry[sKey + "Text"];
				return true;
			});
		});

		return isBlank(sText) ? String(sCode) : String(sText);
	}

	/**
	 * 值帮助：编码 + 描述（"WC01 冷轧一车间"）
	 * @param {string} sCode 编码
	 * @param {object[]} aVhList 值帮助集合
	 * @returns {string} 组合文本
	 * @public
	 */
	function formatVhTextWithCode(sCode, aVhList) {
		if (isBlank(sCode)) {
			return EMPTY;
		}
		var sText = formatVhText(sCode, aVhList);
		return sText === String(sCode) ? sText : String(sCode) + " " + sText;
	}

	/**
	 * 输入框校验状态：true -> Error，false -> None
	 * @param {boolean} bError 是否有错误
	 * @returns {string} sap.ui.core.ValueState 的字符串值
	 * @public
	 */
	function formatValueState(bError) {
		return bError ? "Error" : "None";
	}

	/**
	 * 由值帮助模型数据生成"编码 -> 描述"的映射，用于打印单据
	 * @param {object} oHeader 抬头数据（取 WorkCenter / ProdLine / Team / Warehouse）
	 * @param {object} oVhData JSONModel("vh") 的原始数据
	 * @returns {object} 形如 {WorkCenter: '冷轧一车间', ...} 的映射
	 * @public
	 */
	function buildVhTexts(oHeader, oVhData) {
		var oHeaderData = oHeader || {};
		var oVh = oVhData || {};

		return {
			WorkCenter: formatVhText(oHeaderData.WorkCenter, oVh.WorkCenterVH),
			ProdLine: formatVhText(oHeaderData.ProdLine, oVh.ProdLineVH),
			Team: formatVhText(oHeaderData.Team, oVh.TeamVH),
			Warehouse: formatVhText(oHeaderData.Warehouse, oVh.WarehouseVH)
		};
	}

	return {
		EMPTY: EMPTY,
		formatDecimal3: formatDecimal3,
		formatInteger: formatInteger,
		formatText: formatText,
		formatItemNo: formatItemNo,
		formatVhText: formatVhText,
		formatVhTextWithCode: formatVhTextWithCode,
		formatValueState: formatValueState,
		buildVhTexts: buildVhTexts
	};
});
