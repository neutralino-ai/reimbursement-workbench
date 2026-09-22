import test from 'node:test';
import assert from 'node:assert/strict';
import {purchaseTypeLabel} from '../src/purchase-type.ts';
test('badges distinguish recorded subscriptions from extra usage, never guessing a category from USD 200',()=>{
 for(const plan of ['ChatGPT Pro','ChatGPT Pro Subscription (per seat)','Claude Max 20x 月度订阅'])assert.equal(purchaseTypeLabel(plan),'订阅');
 for(const plan of ['额外用量预充值（Prepaid extra usage, Individual plan）','API token credits'])assert.equal(purchaseTypeLabel(plan),'词元');
 for(const plan of ['', 'USD 200.00','200 USD on the 25th','Anthropic','Subscription plus prepaid credits'])assert.equal(purchaseTypeLabel(plan),'待分类');
});
