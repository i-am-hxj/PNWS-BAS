/*
 * 打印工具 —— 生成 A4 纵向单据（HTML 字符串）并在新窗口中打印。
 *
 * 要点：
 *  1. 只使用 window.open + document.write + print()，不依赖任何第三方库。
 *  2. 所有动态内容都经过 escapeHtml() 转义，防止 HTML 注入。
 *  3. 若浏览器拦截弹窗（window.open 返回 null），用 MessageBox.error 友好提示。
 *  4. @page 设置为 A4 + 12mm 页边距；浏览器自带的页眉页脚可在打印对话框中关闭。
 *  5. print(oHeader, aItems) 打印单张单据；printMany(aDocs) 在一个打印窗口里
 *     依次打印多张单据（每张单独一页，避免连续 window.open 被浏览器拦截）。
 */
sap.ui.define([
	"sap/m/MessageBox",
	"panawin/zinbound/util/Formatter"
], function (MessageBox, Formatter) {
	"use strict";

	var COMPANY_NAME = "派纳维森（苏州）电气科技有限公司";
	var DOC_TITLE = "生产完工入库单";
	var EMPTY = "-";

	// 明细列定义：标题 / 宽度百分比 / 是否数值列 / 取值字段
	// 列宽合计 100%，已按最长内容实测调整（"COIL-20261020-001" 在 17% 下一行放得下）
	var ITEM_COLUMNS = [
		{ title: "行号", width: "8%", numeric: false, field: "ItemNo" },
		{ title: "物料编码", width: "14%", numeric: false, field: "Material" },
		{ title: "盘型编码", width: "8%", numeric: false, field: "CoilType" },
		{ title: "盘号", width: "17%", numeric: false, field: "CoilNo" },
		{ title: "批次号", width: "10%", numeric: false, field: "BatchNo" },
		{ title: "序列号", width: "14%", numeric: false, field: "SerialNo" },
		{ title: "实际长度", width: "10%", numeric: true, field: "ActualLength" },
		{ title: "实际重量", width: "9%", numeric: true, field: "ActualWeight" },
		{ title: "库位编码", width: "10%", numeric: false, field: "StorageBin" }
	];

	/**
	 * HTML 转义（防注入）
	 * @param {*} vValue 任意值
	 * @returns {string} 转义后的文本
	 * @public
	 */
	function escapeHtml(vValue) {
		return String(vValue === null || vValue === undefined ? "" : vValue)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	/**
	 * 文本单元：空值显示 "-"
	 * @param {*} vValue 值
	 * @returns {string} 转义后的文本
	 * @private
	 */
	function text(vValue) {
		var sText = vValue === null || vValue === undefined ? "" : String(vValue).trim();
		return sText === "" ? EMPTY : escapeHtml(sText);
	}

	/**
	 * 数值单元：保留 3 位小数
	 * @param {*} vValue 值
	 * @returns {string} 转义后的文本
	 * @private
	 */
	function decimal(vValue) {
		return escapeHtml(Formatter.formatDecimal3(vValue));
	}

	/**
	 * yyyy-MM-dd HH:mm
	 * @param {Date} oDate 日期
	 * @returns {string} 格式化后的日期时间
	 * @private
	 */
	function formatDateTime(oDate) {
		var oValue = oDate || new Date();

		function pad(iNumber) {
			return iNumber < 10 ? "0" + iNumber : String(iNumber);
		}

		return oValue.getFullYear() + "-" + pad(oValue.getMonth() + 1) + "-" + pad(oValue.getDate()) +
			" " + pad(oValue.getHours()) + ":" + pad(oValue.getMinutes());
	}

	/**
	 * 抬头信息网格（4 列：标签/值/标签/值；创建人、备注各占一行，值跨 3 列）
	 * @param {object} oHeader 抬头数据
	 * @param {object} [mTexts] 值帮助描述 {WorkCenter, ProdLine, Team, Warehouse}
	 * @returns {string} 表格 HTML
	 * @private
	 */
	function buildInfoGrid(oHeader, mTexts) {
		var oTexts = mTexts || {};

		function vh(sCode, sText) {
			if (!sCode) {
				return EMPTY;
			}
			var sSafeCode = escapeHtml(sCode);
			return sText && sText !== EMPTY ? sSafeCode + " " + escapeHtml(sText) : sSafeCode;
		}

		return [
			"<table class=\"info-grid\">",
			"<tbody>",
			"<tr>",
			"<th>工单号</th><td>" + text(oHeader.WorkOrder) + "</td>",
			"<th>生产车间</th><td>" + vh(oHeader.WorkCenter, oTexts.WorkCenter) + "</td>",
			"</tr>",
			"<tr>",
			"<th>产线</th><td>" + vh(oHeader.ProdLine, oTexts.ProdLine) + "</td>",
			"<th>班组</th><td>" + vh(oHeader.Team, oTexts.Team) + "</td>",
			"</tr>",
			"<tr>",
			"<th>库房</th><td>" + vh(oHeader.Warehouse, oTexts.Warehouse) + "</td>",
			"<th>MES单号</th><td>" + text(oHeader.MesNo) + "</td>",
			"</tr>",
			"<tr>",
			"<th>创建人</th><td colspan=\"3\">" + text(oHeader.CreatedBy) + "</td>",
			"</tr>",
			"<tr>",
			"<th>备注</th><td colspan=\"3\" class=\"remark\">" + text(oHeader.Remark) + "</td>",
			"</tr>",
			"</tbody>",
			"</table>"
		].join("");
	}

	/**
	 * 明细表格（奇偶行底色 / 数值列右对齐 / 空值 "-"）
	 * @param {object[]} aItems 明细
	 * @returns {string} 表格 HTML
	 * @private
	 */
	function buildItemsTable(aItems) {
		var aRows = [];

		aRows.push("<table class=\"items\">");
		aRows.push("<colgroup>");
		ITEM_COLUMNS.forEach(function (oColumn) {
			aRows.push("<col style=\"width:" + oColumn.width + "\"/>");
		});
		aRows.push("</colgroup>");
		aRows.push("<thead><tr>");
		ITEM_COLUMNS.forEach(function (oColumn) {
			aRows.push("<th class=\"" + (oColumn.numeric ? "num" : "txt") + "\">" + escapeHtml(oColumn.title) + "</th>");
		});
		aRows.push("</tr></thead>");
		aRows.push("<tbody>");

		var aList = Array.isArray(aItems) ? aItems : [];
		if (aList.length === 0) {
			aRows.push("<tr><td class=\"empty\" colspan=\"" + ITEM_COLUMNS.length + "\">（无明细数据）</td></tr>");
		} else {
			aList.forEach(function (oItem) {
				aRows.push("<tr>");
				ITEM_COLUMNS.forEach(function (oColumn) {
					var sCell = oColumn.numeric ? decimal(oItem[oColumn.field]) : text(oItem[oColumn.field]);
					aRows.push("<td class=\"" + (oColumn.numeric ? "num" : "txt") + "\">" + sCell + "</td>");
				});
				aRows.push("</tr>");
			});
		}

		aRows.push("</tbody>");
		aRows.push("</table>");

		return aRows.join("");
	}

	/**
	 * 合计行（行项目数 / 合计长度 / 合计重量）
	 * 以打印出来的明细求和，保证单据内数据自洽
	 * @param {object[]} aItems 明细
	 * @returns {string} 合计行 HTML
	 * @private
	 */
	function buildTotals(aItems) {
		var aList = Array.isArray(aItems) ? aItems : [];
		var fLength = 0;
		var fWeight = 0;

		aList.forEach(function (oItem) {
			var fItemLength = parseFloat(oItem.ActualLength);
			var fItemWeight = parseFloat(oItem.ActualWeight);
			fLength += isNaN(fItemLength) ? 0 : fItemLength;
			fWeight += isNaN(fItemWeight) ? 0 : fItemWeight;
		});

		return [
			"<div class=\"totals\">",
			"<span class=\"totals-item\">行项目数：<strong>" + aList.length + "</strong></span>",
			"<span class=\"totals-item\">合计长度：<strong>" + escapeHtml(fLength.toFixed(3)) + "</strong></span>",
			"<span class=\"totals-item\">合计重量：<strong>" + escapeHtml(fWeight.toFixed(3)) + "</strong></span>",
			"</div>"
		].join("");
	}

	/**
	 * 打印样式（内联 <style>）
	 * @returns {string} CSS 文本
	 * @private
	 */
	function buildCss() {
		return [
			"@page { size: A4 portrait; margin: 12mm; }",
			"* { box-sizing: border-box; }",
			"html, body { margin: 0; padding: 0; }",
			"body {",
			"  font-family: \"Microsoft YaHei\", SimSun, \"宋体\", Arial, sans-serif;",
			"  font-size: 12px;",
			"  color: #000;",
			"  background: #fff;",
			"  -webkit-print-color-adjust: exact;",
			"  print-color-adjust: exact;",
			"}",
			".sheet { width: 186mm; margin: 0 auto; padding: 10mm; background: #fff; }",
			".sheet + .sheet { page-break-before: always; }",
			".doc-head { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid #000; padding-bottom: 3mm; }",
			".company { font-size: 15px; font-weight: 700; letter-spacing: 1px; }",
			".doc-title { font-size: 20px; font-weight: 700; letter-spacing: 4px; text-align: right; }",
			".doc-sub { display: flex; justify-content: space-between; margin: 3mm 0 2mm 0; font-size: 12px; }",
			"table.info-grid { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 3mm; }",
			"table.info-grid th, table.info-grid td { border: 1px solid #000; padding: 3px 5px; font-size: 11px; vertical-align: middle; }",
			"table.info-grid th { width: 14%; background: #f0f2f5; font-weight: 700; text-align: left; }",
			"table.info-grid td { background: #fff; word-break: break-all; }",
			"table.info-grid td.remark { height: 8mm; }",
			"table.items { width: 100%; border-collapse: collapse; table-layout: fixed; }",
			"table.items th, table.items td { border: 1px solid #000; padding: 3px 5px; font-size: 10.5px; }",
			"table.items th { background: #e8ebf0; font-weight: 700; text-align: center; }",
			"table.items tbody tr:nth-child(odd) { background: #ffffff; }",
			"table.items tbody tr:nth-child(even) { background: #f7f9fc; }",
			"table.items td.txt { text-align: left; word-break: keep-all; white-space: nowrap; overflow: hidden; }",
			"table.items td.num, table.items th.num { text-align: right; font-variant-numeric: tabular-nums; }",
			"table.items th.num { text-align: center; }",
			"table.items td.empty { text-align: center; color: #666; }",
			".totals { display: flex; justify-content: flex-end; gap: 8mm; margin-top: 3mm; font-size: 12px; }",
			".totals strong { font-weight: 700; }",
			".signatures { display: flex; justify-content: space-between; margin-top: 12mm; font-size: 12px; }",
			".signatures span { min-width: 52mm; }",
			".page-foot { margin-top: 8mm; padding-top: 2mm; border-top: 1px solid #999; text-align: right; font-size: 10px; color: #333; }",
			"table.items thead { display: table-header-group; }",
			"tr { page-break-inside: avoid; }",
			"/* 屏幕预览：模拟 A4 纸张 */",
			"@media screen { body { background: #eef1f5; } .sheet { box-shadow: 0 2px 12px rgba(0, 0, 0, .18); } }",
			"/* 打印：去掉屏幕装饰，页面尺寸/边距交给 @page；浏览器自带页眉页脚在打印对话框中关闭 */",
			"@media print {",
			"  html, body { background: #fff !important; }",
			"  .sheet { width: auto; margin: 0; padding: 0; box-shadow: none; }",
			"  .no-print { display: none !important; }",
			"  a[href]:after { content: \"\"; }",
			"}"
		].join("\n");
	}

	/**
	 * 单张单据（一个 A4 页面）
	 * @param {object} oHeader 抬头数据
	 * @param {object[]} aItems 明细数据
	 * @param {object} [mTexts] 值帮助描述
	 * @returns {string} .sheet 片段 HTML
	 * @private
	 */
	function buildSheet(oHeader, aItems, mTexts) {
		var oData = oHeader || {};
		var sInboundNo = oData.InboundNo ? String(oData.InboundNo) : EMPTY;

		return [
			"<div class=\"sheet\">",
			"<div class=\"doc-head\">",
			"<div class=\"company\">" + escapeHtml(COMPANY_NAME) + "</div>",
			"<div class=\"doc-title\">" + escapeHtml(DOC_TITLE) + "</div>",
			"</div>",
			"<div class=\"doc-sub\">",
			"<span>入库单号：" + escapeHtml(sInboundNo) + "</span>",
			"<span>打印日期：" + escapeHtml(formatDateTime(new Date())) + "</span>",
			"</div>",
			buildInfoGrid(oData, mTexts),
			buildItemsTable(aItems),
			buildTotals(aItems),
			"<div class=\"signatures\">",
			"<span>制单人：________________</span>",
			"<span>审核人：________________</span>",
			"<span>仓管员：________________</span>",
			"</div>",
			"<div class=\"page-foot\">第 1 页 / 共 1 页</div>",
			"</div>"
		].join("");
	}

	/**
	 * 把若干张单据包装成完整的 HTML 文档
	 * @param {object[]} aDocs [{header, items, texts}, ...]
	 * @returns {string} 完整 HTML 文档字符串
	 * @private
	 */
	function buildDocumentHtml(aDocs) {
		var aList = Array.isArray(aDocs) ? aDocs : [];
		var sTitle = DOC_TITLE;

		if (aList.length === 1 && aList[0].header && aList[0].header.InboundNo) {
			sTitle = DOC_TITLE + " " + String(aList[0].header.InboundNo);
		}

		var aSheets = aList.map(function (oDoc) {
			return buildSheet(oDoc.header, oDoc.items, oDoc.texts);
		});

		return [
			"<!DOCTYPE html>",
			"<html lang=\"zh-CN\">",
			"<head>",
			"<meta charset=\"utf-8\"/>",
			"<title>" + escapeHtml(sTitle) + "</title>",
			"<style>" + buildCss() + "</style>",
			"</head>",
			"<body>",
			aSheets.join("\n"),
			"</body>",
			"</html>"
		].join("\n");
	}

	/**
	 * 构建完整的 A4 单据 HTML（单张单据，便于单独校验/测试）
	 * @param {object} oHeader 抬头数据
	 * @param {object[]} aItems 明细数据
	 * @param {object} [mTexts] 值帮助描述
	 * @returns {string} 完整 HTML 文档字符串
	 * @public
	 */
	function buildHtml(oHeader, aItems, mTexts) {
		return buildDocumentHtml([{ header: oHeader, items: aItems, texts: mTexts }]);
	}

	/**
	 * 打开打印窗口并写入 HTML
	 * @param {string} sHtml 完整 HTML 文档
	 * @returns {boolean} 是否成功
	 * @private
	 */
	function writeAndPrint(sHtml) {
		var oWindow = null;

		try {
			oWindow = window.open("", "_blank", "width=1100,height=800");
		} catch (oError) {
			oWindow = null;
		}

		if (!oWindow || oWindow.closed || typeof oWindow.document === "undefined") {
			MessageBox.error("打印窗口被浏览器拦截。请允许本站弹出窗口后重新点击\"打印\"。", {
				title: "无法打印"
			});
			return false;
		}

		oWindow.document.open();
		oWindow.document.write(sHtml);
		oWindow.document.close();
		oWindow.focus();

		// 等浏览器完成排版（尤其字体）后再打印，避免打印出空白页
		window.setTimeout(function () {
			try {
				oWindow.print();
			} catch (oError) {
				// 用户取消打印或浏览器不支持，静默处理
			}
		}, 300);

		return true;
	}

	/**
	 * 打印单张单据
	 * @param {object} oHeader 抬头数据
	 * @param {object[]} aItems 明细数据
	 * @param {object} [mTexts] 值帮助描述
	 * @returns {boolean} 是否成功打开打印窗口
	 * @public
	 */
	function print(oHeader, aItems, mTexts) {
		return printMany([{ header: oHeader, items: aItems, texts: mTexts }]);
	}

	/**
	 * 在一个打印窗口中依次打印多张单据（每张一页）
	 * @param {object[]} aDocs [{header, items, texts}, ...]
	 * @returns {boolean} 是否成功打开打印窗口
	 * @public
	 */
	function printMany(aDocs) {
		var aList = (Array.isArray(aDocs) ? aDocs : []).filter(function (oDoc) {
			return !!(oDoc && oDoc.header);
		});

		if (aList.length === 0) {
			MessageBox.error("没有可打印的单据，请先在列表中选择入库单。", {
				title: "无法打印"
			});
			return false;
		}

		return writeAndPrint(buildDocumentHtml(aList));
	}

	return {
		COMPANY_NAME: COMPANY_NAME,
		DOC_TITLE: DOC_TITLE,
		escapeHtml: escapeHtml,
		buildHtml: buildHtml,
		print: print,
		printMany: printMany
	};
});
