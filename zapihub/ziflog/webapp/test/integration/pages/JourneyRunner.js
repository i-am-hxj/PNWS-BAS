sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"ziflog/test/integration/pages/ZC_IFLOGList.gen",
	"ziflog/test/integration/pages/ZC_IFLOGObjectPage.gen"
], function (JourneyRunner, ZC_IFLOGListGenerated, ZC_IFLOGObjectPageGenerated) {
    'use strict';

    const runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('ziflog') + '/test/flp.html#app-preview',
        pages: {
			onTheZC_IFLOGListGenerated: ZC_IFLOGListGenerated,
			onTheZC_IFLOGObjectPageGenerated: ZC_IFLOGObjectPageGenerated
        },
        async: true
    });

    return runner;
});

