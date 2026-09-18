import {useEffect, useRef, useState, type FormEvent, type ReactNode} from 'react';
import type {RecordItem, Workspace} from './types';
import {api} from './api';
import {AuthenticatedFileLink, AuthenticatedImage} from './AuthenticatedFiles';
import {applicationDocuments, arePriorStepsComplete, cny, getExchangeRateEvidence, getNextStep, getRecordWorkflow, workflowSteps, type WorkflowStepId} from './workflow';
import {DeliveryPanel} from './WorkflowView';
import MaterialUpload from './MaterialUpload';
import {PolicyReferences} from './PolicyLibrary';
import './workflow-drawer.css';

type Props = {
  data: Workspace;
  record: RecordItem;
  initialStep?: WorkflowStepId;
  onClose: () => void;
  onReload: () => Promise<Workspace>;
  onOpenMaterials: () => void;
  materials: ReactNode;
  approval: (controls: {onDirty: (value: boolean) => void; onBusy: (value: boolean) => void; busy: boolean}) => ReactNode;
};

export default function RecordWorkflowDrawer({data, record, initialStep, onClose, onReload, onOpenMaterials, materials, approval}: Props) {
  const [step, setStep] = useState<WorkflowStepId>(initialStep || getNextStep(record, data) || 'approval');
  const [switchTo, setSwitchTo] = useState<WorkflowStepId | null>(null);
  const [discardToClose, setDiscardToClose] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const unsavedRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const stateRef = useRef({dirty,busy});
  stateRef.current = {dirty,busy};
  const steps = getRecordWorkflow(record, data);
  const definition = workflowSteps.find(item => item.id === step)!;
  const current = steps.find(item => item.id === step)!;
  const reviewSource = data.arpRecords.find(item => item.id === record.financeReviewARPId);

  useEffect(() => {
    if (!dirty) { setSwitchTo(null); setDiscardToClose(false); }
  }, [dirty]);
  useEffect(() => {
    if (switchTo || discardToClose) {
      unsavedRef.current?.focus();
      unsavedRef.current?.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    }
  }, [switchTo, discardToClose]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (stateRef.current.busy) return;
        if (stateRef.current.dirty) setDiscardToClose(true);
        else onCloseRef.current();
      }
      if (event.key === 'Tab') {
        const nodes = [...(drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary') || [])].filter(node => node.getClientRects().length > 0);
        if (!nodes.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown',onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown',onKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  },[]);

  function close() {
    if (busy) return;
    if (dirty) setDiscardToClose(true);
    else onClose();
  }
  function navigate(target: WorkflowStepId) {
    if (busy || step === target) return;
    if (dirty) setSwitchTo(target);
    else { setStep(target); setDiscardToClose(false); }
  }
  function discard() {
    setDirty(false);
    if (discardToClose) { onClose(); return; }
    if (switchTo) setStep(switchTo);
    setSwitchTo(null);
  }

  return <div className="drawer-layer">
    <div className="drawer-backdrop" onClick={close} />
    <aside ref={drawerRef} className="record-drawer workflow-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <header className="drawer-header"><div><h2 id="drawer-title">{record.billingMonth.slice(0, 4)} 年 {Number(record.billingMonth.slice(5))} 月</h2></div><button ref={closeRef} className="icon-button" aria-label="关闭详情" onClick={close} disabled={busy}>×</button></header>
      <div className="drawer-body">
        <div className="workflow-record-summary"><span>{record.invoiceNumber}<small>{record.accountName}</small></span><strong>{record.currency} {record.amount}</strong></div>
        <nav className="record-step-nav" aria-label="这笔报销的流程步骤">
          {workflowSteps.map((item,index) => <button key={item.id} className={`${step === item.id ? 'active' : ''} ${steps[index].state}`} aria-pressed={step === item.id} onClick={() => navigate(item.id)} disabled={busy}><span>{steps[index].state === 'done' ? '✓' : steps[index].state === 'attention' ? '!' : index+1}</span>{item.shortTitle}<small>{steps[index].state === 'done' ? '已完成' : steps[index].state === 'attention' ? '需处理' : '待维护'}</small></button>)}
        </nav>
        {(switchTo || discardToClose) && <div ref={unsavedRef} tabIndex={-1} className="workflow-unsaved" role="alert"><strong>这一步有尚未保存的修改</strong><p>可以继续编辑并保存，或放弃本次修改。</p><div><button className="button secondary" onClick={() => {setSwitchTo(null);setDiscardToClose(false);}}>继续编辑</button><button className="button danger" onClick={discard}>{discardToClose ? '放弃修改并关闭' : '放弃修改并切换'}</button></div></div>}
        <section className="workflow-step-intro" aria-labelledby="step-title"><div><span className={`workflow-step-state ${current.state}`}>{current.state === 'done' ? '已完成' : current.state === 'attention' ? '需要处理' : step === 'approval' && record.financeReviewPending ? '审核中' : '待维护'}</span><h3 id="step-title">{definition.title}</h3></div>{(step !== 'claim' || arePriorStepsComplete(record)) && <p className="workflow-step-detail">{current.detail}</p>}</section>
        {step === 'materials' && <section className="drawer-section"><div className="section-heading"><h3>原始文件</h3><span className="small-muted">{record.materials.length} 份</span></div>{materials}<MaterialUpload record={record} role="invoice" onReload={onReload} onBusy={setBusy} /><button className="text-button" onClick={onOpenMaterials}>全部材料与来源 →</button></section>}
        {step === 'payment' && <><div className="drawer-section"><MaterialUpload record={record} role="payment" onReload={onReload} onBusy={setBusy} disabled={dirty} /></div><details className="workflow-evidence" open><summary>发票与付款原件</summary>{materials}</details><ReviewStepForm key={`${step}:${record.version}`} step={step} record={record} onReload={onReload} onDirty={setDirty} onBusy={setBusy} /></>}
        {step === 'claim' && <><ApplicationFiles data={data} record={record} /><details className="workflow-evidence"><summary>申报金额与换算依据</summary><ReviewStepForm key={step} step={step} record={record} onReload={onReload} onDirty={setDirty} onBusy={setBusy} />{materials}</details></>}
        {step === 'submission' && <DeliveryPanel data={data} onReload={onReload} recordID={record.id} />}
        {step === 'approval' && <>{record.financeReviewPending && <section className="drawer-section"><dl className="fx-summary"><div><dt>报销单号</dt><dd>{record.submissionReference}</dd></div><div><dt>本笔待审金额</dt><dd>{cny(record.claimedCNY)}</dd></div><div><dt>ARP 状态</dt><dd>{reviewSource?.status || '财务审核中'}</dd></div><div><dt>上次查询</dt><dd>{reviewSource?.observedAt ? new Date(reviewSource.observedAt).toLocaleString('zh-CN', {hour12:false}) : '未记录'}</dd></div></dl>{(record.financeReviewEvidenceIDs || []).map(id => <AuthenticatedFileLink key={id} className="material-item" href={`/api/materials/${encodeURIComponent(id)}`}>查看财务审核记录</AuthenticatedFileLink>)}</section>}{record.financeReviewPending ? <details className="workflow-evidence"><summary>审核通过后关联金额</summary>{approval({onDirty:setDirty,onBusy:setBusy,busy})}</details> : <section className="drawer-section">{approval({onDirty:setDirty,onBusy:setBusy,busy})}</section>}<details className="workflow-evidence"><summary>ARP 单号与提交日期</summary><ReviewStepForm key="arp-registration" step="submission" record={record} onReload={onReload} onDirty={setDirty} onBusy={setBusy} /></details></>}
        <div className="workflow-drawer-footer"><span>财务审核中：前四步完成；全部通过：五步完成。</span><button className="text-button" onClick={() => navigate(workflowSteps[(workflowSteps.findIndex(item => item.id === step)+1)%workflowSteps.length].id)} disabled={busy}>{step === 'approval' ? '返回材料' : '查看下一步'} →</button></div>
      </div>
    </aside>
  </div>;
}

function ApplicationFiles({data, record}: {data: Workspace; record: RecordItem}) {
  const priorComplete = arePriorStepsComplete(record);
  const exchange = getExchangeRateEvidence(record, data);
  const fx = record.exchangeRate;
  const ready = applicationDocuments(record, data);
  const documents = (data.documents || []).filter(document => document.recordIDs.includes(record.id));
  const policyBasis = (data.policies || []).filter(policy => policy.status === 'active').map(policy => `${policy.title}（${policy.versionLabel}）：${policy.note}`).join('；');
  const submissionPDFs = ready.flatMap(document => document.materials.filter(material => material.id === document.submissionPDFMaterialID));
  const [taskText, setTaskText] = useState('');
  const [message, setMessage] = useState('');
  const task = `请按 reimbursement-workflow Skill 处理 ${record.billingMonth} 的 ${record.invoiceNumber}。先通过 MCP 读取记录 ${record.id} 的当前版本，以及 workspace.policies 中的当前规则原件、条款与适用范围。${policyBasis ? `当前依据：${policyBasis}。` : ''}用户已确认：有适用明文按条款，没有条款沿用过去成功报销的同类先例。GPT 采用 invoice 日期 ${record.date} 的中国银行 ${record.currency} 中行折算价（每100外币），无需再次确认汇率类别；说明中标注“沿用已通过报销先例”，不写成制度明文。保存官网实际截图并用 exchangeRate.set 登记。先沿用本条已有发票和付款原件，缺失时检查旧 DOCX/PDF；不得借用其他月份证据。由 Agent 填写情况说明，生成可编辑 DOCX，并将说明、原始发票、付款截图和汇率截图整合为一个交财务 PDF。用 document.register 的 purpose:application 和 submissionPDFMaterialID 登记来源、精确版本和渲染检查结果；sourceMaterialIDs 包含所引用的制度原件，说明中注明制度版本、条款及页码。缺原件或金额尚未核实的申请包保留草稿，不因制度未明确汇率类别而阻塞。已提交或获批金额不得因本次汇率重算自动覆盖。${record.billingMonth === '2026-06' ? '六月提交归属未知仍需核对。' : ''}已进入财务审核的记录无需重建申请。`;
  async function copyTask() {
    try { await navigator.clipboard.writeText(task); setMessage('已复制材料准备任务'); setTaskText(''); }
    catch { setTaskText(task); setMessage('请复制下方任务'); }
  }
  return <section className="drawer-section application-section">
    <PolicyReferences data={data} />
    {priorComplete && <p className="form-hint">已进入财务审核，此步骤自动完成。</p>}
    {!priorComplete && <div className="fx-panel">
      <h3>发票当日汇率</h3>
      <p className="form-hint">按已通过报销先例，使用发票日期的中行折算价。此口径已确认，保留官网截图作为金额依据。</p>
      <dl className="fx-summary"><div><dt>对应发票日期</dt><dd>{record.date}</dd></div><div><dt>汇率来源</dt><dd>中国银行 · 中行折算价</dd></div><div><dt>每 100 {record.currency}</dt><dd>{record.currency === 'CNY' ? '无需外汇换算' : exchange.valid && fx ? `${fx.quotedRate} CNY` : '待查询并保存截图'}</dd></div><div><dt>换算人民币</dt><dd>{record.currency === 'CNY' ? cny(record.amount) : exchange.valid && fx ? cny(fx.cnyAmount) : '待确认'}</dd></div></dl>
      {exchange.valid && fx && record.currency !== 'CNY' && <p className="fx-formula">{record.amount} × {fx.quotedRate} ÷ 100 = {cny(fx.cnyAmount)}</p>}
      {exchange.valid && fx && record.claimConfirmed && record.claimedCNY !== fx.cnyAmount && <p className="form-hint">已登记申报 {cny(record.claimedCNY)}，与本次按发票日期换算的金额不同，需核对后处理。</p>}
      {exchange.screenshots.map(material => <AuthenticatedFileLink key={material.id} href={material.href} filename={material.filename}><AuthenticatedImage className="fx-evidence-image" src={material.href} alt={`${record.date} 中国银行${record.currency}中行折算价官网截图`} /><span className="text-button">查看完整汇率截图</span></AuthenticatedFileLink>)}
      {!exchange.valid && record.currency !== 'CNY' && <p className="form-hint">{fx ? exchange.issues.join('；') : '缺少发票当日的官网截图，旧汇率不会自动套用。'}</p>}
      {record.currency !== 'CNY' && <a className="text-button" href={fx?.valid ? fx.sourceUrl : 'https://www.boc.cn/sourcedb/whpjSearch/index.html'} target="_blank" rel="noreferrer">中国银行历史牌价</a>}
    </div>}
    <div className="application-checklist">
      {([{role:'invoice',label:'原始发票'},{role:'payment',label:'付款凭证'}] as const).map(({role,label}) => {
        const files = record.materials.filter(material => material.role === role);
        return <div className="application-source-row" key={role}><strong>{label}</strong><div>{files.length ? files.map(material => <AuthenticatedFileLink key={material.id} href={material.href} filename={material.filename}>{material.filename}{material.integrity !== 'ok' && '（原件异常）'}</AuthenticatedFileLink>) : <span className="missing">{priorComplete ? '无需补件；未留存原件' : '待收集'}</span>}</div></div>;
      })}
      <div className="application-source-row"><strong>情况说明</strong><div>{ready.length ? ready.flatMap(document => document.materials.filter(material => /\.docx$/i.test(material.filename))).map(material => <AuthenticatedFileLink key={material.id} href={material.href} filename={material.filename}>{material.filename}</AuthenticatedFileLink>) : <span className={priorComplete ? '' : 'missing'}>{priorComplete ? '无需重建；未留存 Word' : '待编写情况说明 Word'}</span>}<small>记录用途、发票日期、原币金额和人民币换算依据。</small></div></div>
    </div>
    {submissionPDFs.map(material => <AuthenticatedFileLink key={material.id} className="application-pdf" href={material.href} filename={material.filename}><span><strong>交财务 PDF</strong><small>情况说明、发票、付款凭证、汇率截图已整合</small></span><span>查看 PDF</span></AuthenticatedFileLink>)}
    {!submissionPDFs.length && !priorComplete && <div className="application-missing">整合 PDF 待生成。集齐凭证、确认金额后，将情况说明和全部附件合并为一个文件。</div>}
    {!priorComplete && <button className="button secondary full-width" onClick={() => void copyTask()}>复制材料准备任务</button>}
    {message && <p className="form-hint" role="status">{message}</p>}
    {taskText && <textarea className="full-width" readOnly value={taskText} rows={5} aria-label="材料准备任务" />}
    {documents.length > 0 && <details className="workflow-evidence"><summary>历史说明与草稿（{documents.length}）</summary>{documents.map(document => <div key={document.id} className="application-file-group"><strong>{document.title}</strong><p className="form-hint">{document.purpose !== 'application' ? '材料核对说明' : document.needsUpdate || document.stale ? '需要更新' : document.status === 'ready' ? '已准备' : '草稿'}</p>{document.materials.map(material => <AuthenticatedFileLink key={material.id} className="material-item" href={material.href} filename={material.filename}>{material.filename}</AuthenticatedFileLink>)}</div>)}</details>}
  </section>;
}

function ReviewStepForm({step,record,onReload,onDirty,onBusy}: {step:WorkflowStepId;record:RecordItem;onReload:()=>Promise<Workspace>;onDirty:(value:boolean)=>void;onBusy:(value:boolean)=>void}) {
  const [claimedCNY,setClaimedCNY] = useState(record.claimedCNY);
  const [paymentVerified,setPaymentVerified] = useState(record.paymentVerified);
  const [claimConfirmed,setClaimConfirmed] = useState(record.claimConfirmed);
  const [submissionReference,setSubmissionReference] = useState(record.submissionReference);
  const [submittedOn,setSubmittedOn] = useState(record.submittedOn);
  const [note,setNote] = useState('');
  const editVersion = useRef(record.version);
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState('');
  const [success,setSuccess] = useState('');
  const changed = note !== '' || (step === 'payment' && paymentVerified !== record.paymentVerified) || (step === 'claim' && (claimedCNY !== record.claimedCNY || claimConfirmed !== record.claimConfirmed)) || (step === 'submission' && (submissionReference !== record.submissionReference || submittedOn !== record.submittedOn));
  useEffect(() => {onDirty(changed);},[changed,onDirty]);
  const saveLabel = step === 'payment' ? '保存付款核验' : step === 'claim' ? '保存申报信息' : '保存提交登记';
  async function save(event:FormEvent) {
    event.preventDefault();setSaving(true);onBusy(true);setError('');setSuccess('');
    let saved = false;
    try {
      // Refresh before updating a step so it cannot restore stale facts from another step.
      const latest = (await api<Workspace>('/api/workspace')).records.find(item => item.id === record.id);
      if (!latest) throw new Error('这笔记录已不存在，请刷新台账。');
      if (editVersion.current && latest.version !== editVersion.current) throw new Error('这笔记录在编辑期间已更新，请重新打开并核对后保存。');
      await api(`/api/records/${encodeURIComponent(record.id)}/review`,{method:'POST',body:JSON.stringify({
        baseVersion:latest.version,
        claimedCNY:step === 'claim' ? claimedCNY : latest.claimedCNY,
        claimConfirmed:step === 'claim' ? claimConfirmed : latest.claimConfirmed,
        paymentVerified:step === 'payment' ? paymentVerified : latest.paymentVerified,
        submissionReference:step === 'submission' ? submissionReference : latest.submissionReference,
        submittedOn:step === 'submission' ? submittedOn : latest.submittedOn,
        note,
      })});
      saved = true;
      const refreshed = (await onReload()).records.find(item => item.id === record.id)!;
      editVersion.current = refreshed.version;
      setClaimedCNY(refreshed.claimedCNY);setClaimConfirmed(refreshed.claimConfirmed);setPaymentVerified(refreshed.paymentVerified);
      setSubmissionReference(refreshed.submissionReference);setSubmittedOn(refreshed.submittedOn);
      setNote('');setSuccess('已保存，流程进度已更新。');
    } catch(err) {setError((saved ? '记录已保存，但刷新失败，请重新打开详情核对。' : '') + (err instanceof Error ? err.message : '保存失败，请重试'));}
    finally {setSaving(false);onBusy(false);}
  }
  return <form className="drawer-section review-form" onSubmit={save}><fieldset className="workflow-form-fields" disabled={saving}>
    {step === 'payment' && <><label className="check-field"><input type="checkbox" checked={paymentVerified} onChange={event=>setPaymentVerified(event.target.checked)} /><span><strong>已核验实际付款</strong><small>已对照发票和付款凭证；发票存在不等于付款完成。</small></span></label><p className="form-hint">取消勾选并说明原因，可以撤回之前的付款确认。</p></>}
    {step === 'claim' && <><label className="field-label">人民币申报金额<div className="money-input"><span>¥</span><input inputMode="decimal" aria-label="人民币申报金额" placeholder="例如 1420.00" value={claimedCNY} onChange={event=>setClaimedCNY(event.target.value)} /></div></label><label className="check-field"><input type="checkbox" checked={claimConfirmed} onChange={event=>setClaimConfirmed(event.target.checked)} /><span><strong>已确认申报金额</strong><small>已核对汇率、报销范围及金额依据。</small></span></label><p className="form-hint">原币 {record.currency} {record.amount} 单独保留；申报金额不会自动换算。已有审批关联时，金额不能低于已关联金额。</p></>}
    {step === 'submission' && <><div className="form-row"><label className="field-label">提交单号<input value={submissionReference} onChange={event=>setSubmissionReference(event.target.value)} placeholder="ARP 单号或提交编号" /></label><label className="field-label">提交日期<input type="date" value={submittedOn} onChange={event=>setSubmittedOn(event.target.value)} /></label></div><p className="form-hint">登记已经发生的提交。这里保存的是本地记录，不会向 ARP 提交申请。尚未提交时可留空。</p><a className="text-button" href="https://ihep.arp.cn" target="_blank" rel="noreferrer">打开 IHEP ARP ↗</a></>}
    <label className="field-label">本次核验说明 <span className="required">必填</span><textarea required rows={3} value={note} onChange={event=>setNote(event.target.value)} placeholder={step === 'payment' ? '说明付款日期、金额和核对的凭证…' : step === 'claim' ? '说明汇率、人民币金额及申报范围的依据…' : '说明提交情况或本次更正的原因…'} /></label>
    {record.notes && <details className="previous-notes"><summary>查看已有核验说明</summary><p>{record.notes}</p></details>}
    {error && <div className="feedback error" role="alert">{error}</div>}
    {success && <div className="feedback success" role="status">{success}</div>}
    <button className="button primary full-width" type="submit" disabled={saving}>{saving ? '正在保存…' : saveLabel}</button>
  </fieldset></form>;
}
