/** Use the documented purchase description; price and day-of-month are not categories. */
export function purchaseType(plan=''){
  const tokens=/extra[\s_-]*usage|\b(?:api|token|usage)[\s_-]+credits?\b|\bcredits\b|\btokens?\b|词元|预充值|额度充值/i.test(plan);
  const subscription=/订阅|subscription|subscr\b|月度|年度|(?:chatgpt|claude)\s+(?:pro|plus|max|team|business)\b|^(?:pro|plus|max|team|business)(?:\b|\s)/i.test(plan);
  return tokens===subscription?'unknown':tokens?'tokens':'subscription';
}
export const purchaseTypeLabel=(plan='')=>({subscription:'订阅',tokens:'词元',unknown:'待分类'}[purchaseType(plan)]);
