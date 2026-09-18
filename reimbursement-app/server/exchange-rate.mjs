const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

export function isOfficialBOCURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
      ['boc.cn', 'bankofchina.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

// Signature checks identify the file format; they do not certify screenshot contents.
export function imageFormat(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'png';
  if (bytes.length >= 16 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'jpeg';
  if (bytes.length >= 20 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) return 'gif';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'webp';
  if (bytes.length >= 24 && bytes.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1'].includes(bytes.toString('ascii', 8, 12))) return 'heic';
  return null;
}

export function convertBOCAmount(amount, quotedRate) {
  if (typeof amount !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(amount)) fail('发票金额须为最多两位小数的正数。');
  if (typeof quotedRate !== 'string' || !/^\d{1,7}(?:\.\d{1,6})?$/.test(quotedRate)) fail('中行折算价须为最多六位小数的十进制字符串。');
  const [amountWhole, amountFraction = ''] = amount.split('.');
  const [rateWhole, rateFraction = ''] = quotedRate.split('.');
  const amountCents = BigInt(amountWhole) * 100n + BigInt(amountFraction.padEnd(2, '0'));
  const scale = 10n ** BigInt(rateFraction.length);
  const rateInteger = BigInt(rateWhole) * scale + BigInt(rateFraction || '0');
  if (amountCents <= 0n || rateInteger <= 0n || rateInteger > 1_000_000n * scale) fail('发票金额和中行折算价必须为正数，报价不能超过每100外币1,000,000元。');
  const denominator = 100n * scale;
  const result = (amountCents * rateInteger + denominator / 2n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail('人民币换算金额超过台账精确金额范围。');
  return `${result / 100n}.${String(result % 100n).padStart(2, '0')}`;
}

export function exchangeRateView(record) {
  const rate = record.exchangeRate;
  if (!rate) return null;
  const issues = [];
  if (record.currency === 'CNY') issues.push('人民币发票无需外币汇率。');
  if (rate.date !== record.date) issues.push(`汇率日期 ${rate.date || '缺失'} 与发票日期 ${record.date} 不一致。`);
  if (rate.currency !== record.currency) issues.push('汇率币种与发票币种不一致。');
  if (rate.provider !== 'BOC' || rate.rateType !== '中行折算价' || rate.unit !== 100) issues.push('汇率须使用中国银行中行折算价，每100外币兑人民币。');
  if (!isOfficialBOCURL(rate.sourceUrl)) issues.push('汇率来源必须是 boc.cn 或 bankofchina.com 官方网页。');
  let cnyAmount = '';
  try { cnyAmount = convertBOCAmount(record.amount, rate.quotedRate); }
  catch (error) { issues.push(error.message); }
  const evidenceIDs = Array.isArray(rate.evidenceIDs) ? rate.evidenceIDs : [];
  if (!evidenceIDs.length) issues.push('缺少中行官网汇率原始截图。');
  for (const id of evidenceIDs) {
    const material = record.materials.find(item => item.id === id);
    if (!material || material.role !== 'exchangeRate' || material.integrity !== 'ok' || !material.imageFormat || !/\.(png|jpe?g|gif|webp|heic)$/i.test(material.filename)) {
      issues.push(`汇率证据 ${id} 必须是完整的原始图片截图，不能使用整理表、JSON 或文档。`);
    } else if (!['browser-download', 'browser-observation'].includes(material.source?.kind) || !isOfficialBOCURL(material.source?.url)) {
      issues.push(`汇率截图 ${id} 缺少中行官网浏览器采集来源。`);
    }
  }
  return { ...rate, evidenceIDs, cnyAmount, valid: issues.length === 0, issues };
}
