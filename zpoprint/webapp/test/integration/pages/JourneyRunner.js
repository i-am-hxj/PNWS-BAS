sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"zpoprint/test/integration/pages/PurchaseOrderItemList.gen",
	"zpoprint/test/integration/pages/PurchaseOrderItemObjectPage.gen"
], function (JourneyRunner, PurchaseOrderItemListGenerated, PurchaseOrderItemObjectPageGenerated) {
    'use strict';

    const runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('zpoprint') + '/test/flp.html#app-preview',
        pages: {
			onThePurchaseOrderItemListGenerated: PurchaseOrderItemListGenerated,
			onThePurchaseOrderItemObjectPageGenerated: PurchaseOrderItemObjectPageGenerated
        },
        async: true
    });

    return runner;
});

