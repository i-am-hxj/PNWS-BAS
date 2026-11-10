sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"zfixedassetlabel/test/integration/pages/FixedAssetLabelList.gen",
	"zfixedassetlabel/test/integration/pages/FixedAssetLabelObjectPage.gen"
], function (JourneyRunner, FixedAssetLabelListGenerated, FixedAssetLabelObjectPageGenerated) {
    'use strict';

    const runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('zfixedassetlabel') + '/test/flp.html#app-preview',
        pages: {
			onTheFixedAssetLabelListGenerated: FixedAssetLabelListGenerated,
			onTheFixedAssetLabelObjectPageGenerated: FixedAssetLabelObjectPageGenerated
        },
        async: true
    });

    return runner;
});

