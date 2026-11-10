/*
 * 抬头合计工具（纯函数，无 UI5 运行时依赖，便于 Node 单测）
 *
 * 计算：行项目数 / 合计长度 / 合计重量
 *
 * 为什么合计在前端算：
 *   本系统的行为实现类装不进本地处理类（MESSAGE(GBK)），RAP determination
 *   不可用，服务端不会在 on save 时重算合计。
 *   因此改为：前端保存前算好，随抬头 UPDATE 一起提交。
 *   服务端字段已放开 readonly 以便接收（见 src/03-rap/zi_inbzb_hdr.bdef.asbdef）。
 *
 * 约定：
 *   - 标记删除的行（_state === "deleted"）不计入
 *   - 长度/重量保留 3 位小数（与表字段 abap.dec(15,3)、OData Edm.Decimal(15,3) 一致）
 *   - 非数字按 0 处理（不抛错，避免脏数据让保存整体失败）
 */
sap.ui.define([], function () {
	"use strict";

	var DECIMALS = 3;

	/**
	 * 解析为数值
	 * @param {*} vValue 原始值（可能是字符串、null）
	 * @returns {number} 数值；非法值返回 0
	 * @private
	 */
	function toNumber(vValue) {
		var fValue = parseFloat(vValue);
		return isNaN(fValue) || !isFinite(fValue) ? 0 : fValue;
	}

	/**
	 * 四舍五入到 3 位小数（避免 0.1+0.2 这类浮点误差累积）
	 * @param {number} fValue 数值
	 * @returns {number} 舍入后的数值
	 * @private
	 */
	function round3(fValue) {
		var fFactor = Math.pow(10, DECIMALS);
		return Math.round((fValue + Number.EPSILON) * fFactor) / fFactor;
	}

	/**
	 * 是否应计入合计
	 * @param {object} oItem 明细行
	 * @returns {boolean} 是否计入
	 * @private
	 */
	function isCountable(oItem) {
		return !!oItem && oItem._state !== "deleted";
	}

	/**
	 * 计算合计
	 * @param {object[]} aItems 明细行数组
	 * @returns {{TotalItems: number, TotalLength: string, TotalWeight: string}} 合计
	 *   TotalItems 为整数；TotalLength/TotalWeight 为 3 位小数字符串
	 * @public
	 */
	function computeTotals(aItems) {
		var iCount = 0;
		var fLength = 0;
		var fWeight = 0;

		(aItems || []).forEach(function (oItem) {
			if (!isCountable(oItem)) {
				return;
			}
			iCount += 1;
			fLength += toNumber(oItem.ActualLength);
			fWeight += toNumber(oItem.ActualWeight);
		});

		return {
			TotalItems: iCount,
			TotalLength: round3(fLength).toFixed(DECIMALS),
			TotalWeight: round3(fWeight).toFixed(DECIMALS)
		};
	}

	/**
	 * 合计是否与抬头里已存的值不同
	 * @param {object} oHeader 抬头
	 * @param {{TotalItems: number, TotalLength: string, TotalWeight: string}} oTotals 计算出的合计
	 * @returns {boolean} 是否有差异
	 * @public
	 */
	function differs(oHeader, oTotals) {
		var oH = oHeader || {};
		return toNumber(oH.TotalItems) !== toNumber(oTotals.TotalItems) ||
			round3(toNumber(oH.TotalLength)) !== round3(toNumber(oTotals.TotalLength)) ||
			round3(toNumber(oH.TotalWeight)) !== round3(toNumber(oTotals.TotalWeight));
	}

	return {
		DECIMALS: DECIMALS,
		computeTotals: computeTotals,
		differs: differs
	};
});
