/*
 * 入库单号工具（纯函数，无 UI5 运行时依赖，便于 Node 单测）
 *
 * 单号规则：IN + yyyyMMdd + 4 位当日流水号，共 14 位
 *   例：IN202610200001
 *
 * 为什么编号在前端做：
 *   本系统（ADT 3.60.4 + 后端）的行为实现类无法容纳
 *   INHERITING FROM cl_abap_behavior_handler 的本地处理类
 *   （MESSAGE(GBK)，ADT 的 Ctrl+F3 也一样报错），
 *   因此 RAP determination 装不进去，服务端不能在 on save 时赋值主键。
 *   所以改为：前端取号 -> 随 create 一起提交 -> 服务端只做唯一性约束。
 *   详见 docs/08-开发过程复盘与最佳实践.md 与 docs/07 §2.3。
 *
 * 并发说明：
 *   取号是"查当天最大流水 +1"，两个用户同时新建可能拿到同一个号。
 *   服务端主键冲突时 create 会返回 409/400（"关键值已在使用中"），
 *   调用方（List.controller）会重新取号重试，最多 3 次。
 */
sap.ui.define([], function () {
	"use strict";

	var PREFIX = "IN";
	var SERIAL_LEN = 4;
	var MAX_SERIAL = 9999;
	var NO_LENGTH = PREFIX.length + 8 + SERIAL_LEN; // 14

	// IN + 8 位日期 + 4 位流水
	var RE_INBOUND_NO = /^IN(\d{8})(\d{4})$/;

	/**
	 * 两位补零
	 * @param {number} iValue 数值
	 * @returns {string} 两位字符串
	 * @private
	 */
	function pad2(iValue) {
		return (iValue < 10 ? "0" : "") + iValue;
	}

	/**
	 * 日期格式化为 yyyyMMdd（按本地时区，与用户看到的一致）
	 * @param {Date} [oDate] 日期，默认当前时间
	 * @returns {string} 形如 20261020
	 * @public
	 */
	function formatDate(oDate) {
		var oD = oDate || new Date();
		return String(oD.getFullYear()) + pad2(oD.getMonth() + 1) + pad2(oD.getDate());
	}

	/**
	 * 取当天单号前缀
	 * @param {Date} [oDate] 日期，默认当前时间
	 * @returns {string} 形如 IN20261020
	 * @public
	 */
	function todayPrefix(oDate) {
		return PREFIX + formatDate(oDate);
	}

	/**
	 * 拼出单号
	 * @param {number} iSerial 当日流水号（1..9999）
	 * @param {Date} [oDate] 日期，默认当前时间
	 * @returns {string} 14 位单号；流水号越界时返回空串
	 * @public
	 */
	function buildNo(iSerial, oDate) {
		var iSeq = parseInt(iSerial, 10);
		if (isNaN(iSeq) || iSeq < 1 || iSeq > MAX_SERIAL) {
			return "";
		}
		var sSerial = String(iSeq);
		while (sSerial.length < SERIAL_LEN) {
			sSerial = "0" + sSerial;
		}
		return todayPrefix(oDate) + sSerial;
	}

	/**
	 * 从单号解析当日流水号
	 * @param {string} sNo 单号
	 * @returns {number} 流水号；格式不符返回 -1
	 * @public
	 */
	function parseSerial(sNo) {
		var aMatch = RE_INBOUND_NO.exec(String(sNo || ""));
		return aMatch ? parseInt(aMatch[2], 10) : -1;
	}

	/**
	 * 判断单号是否属于指定日期
	 * @param {string} sNo 单号
	 * @param {Date} [oDate] 日期，默认当前时间
	 * @returns {boolean} 是否同一天
	 * @public
	 */
	function isSameDay(sNo, oDate) {
		var aMatch = RE_INBOUND_NO.exec(String(sNo || ""));
		return !!aMatch && aMatch[1] === formatDate(oDate);
	}

	/**
	 * 校验单号格式（长度 14 且符合 IN+yyyyMMdd+4 位）
	 * @param {string} sNo 单号
	 * @returns {boolean} 是否合法
	 * @public
	 */
	function isValidNo(sNo) {
		var sValue = String(sNo || "");
		return sValue.length === NO_LENGTH && RE_INBOUND_NO.test(sValue);
	}

	/**
	 * 在已有单号里找当天最大流水号，返回下一个
	 * @param {string[]} aExistingNos 已有单号（可以包含其它日期的，会被忽略）
	 * @param {Date} [oDate] 日期，默认当前时间
	 * @returns {string} 下一个可用单号；当天用尽（>9999）时返回空串
	 * @public
	 */
	function nextNo(aExistingNos, oDate) {
		var iMax = 0;
		(aExistingNos || []).forEach(function (sNo) {
			if (!isSameDay(sNo, oDate)) {
				return;
			}
			var iSeq = parseSerial(sNo);
			if (iSeq > iMax) {
				iMax = iSeq;
			}
		});
		if (iMax >= MAX_SERIAL) {
			return ""; // 当日号段用尽
		}
		return buildNo(iMax + 1, oDate);
	}

	return {
		PREFIX: PREFIX,
		SERIAL_LEN: SERIAL_LEN,
		MAX_SERIAL: MAX_SERIAL,
		NO_LENGTH: NO_LENGTH,
		formatDate: formatDate,
		todayPrefix: todayPrefix,
		buildNo: buildNo,
		parseSerial: parseSerial,
		isSameDay: isSameDay,
		isValidNo: isValidNo,
		nextNo: nextNo
	};
});
