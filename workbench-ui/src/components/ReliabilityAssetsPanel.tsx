import { useEffect, useMemo, useState } from "react";
import {
  applyTestAsset,
  createDifferentialRun,
  createTestAsset,
  getDifferentialRun,
  getReliabilityAssetContext,
  getTestAsset,
  validateTestAsset
} from "../api";
import type { DifferentialRunView, ReliabilityAssetContext, TestAssetView } from "../reliabilityTypes";

interface ReliabilityAssetsPanelProps {
  projectId?: string;
  sourceRunId?: string | null;
  repositoryRoot?: string;
}

type AssetResponse = {
  value: TestAssetView;
  target: { clean: boolean; status: string; patch: string; repositorySha256: string; patchSha256: string };
  oracleSpecs?: TestAssetView["oracleSpecs"];
};

function parsePayload(value: string) {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function terminal(status?: string) {
  return ["completed", "blocked", "failed", "cancelled"].includes(status ?? "");
}

function planFor(context: ReliabilityAssetContext) {
  return {
    sessionName: `Workbench reliability ${context.sourceRunId ?? context.projectId}`,
    coverageItemIds: context.coverageItems.map((item) => item.id),
    source: "workbench-reliability"
  };
}

export function ReliabilityAssetsPanel(props: ReliabilityAssetsPanelProps) {
  const [context, setContext] = useState<ReliabilityAssetContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [differentialId, setDifferentialId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [differential, setDifferential] = useState<DifferentialRunView | null>(null);
  const [asset, setAsset] = useState<AssetResponse | null>(null);
  const [message, setMessage] = useState("");
  const [advancedDifferential, setAdvancedDifferential] = useState(false);
  const [advancedAsset, setAdvancedAsset] = useState(false);
  const [differentialRequest, setDifferentialRequest] = useState("{}");
  const [assetRequest, setAssetRequest] = useState("{}");
  const [baseRevision, setBaseRevision] = useState("");
  const [headRevision, setHeadRevision] = useState("");
  const [dataContractId, setDataContractId] = useState("");
  const [oracleSpecIds, setOracleSpecIds] = useState<string[]>([]);
  const [coverageItemIds, setCoverageItemIds] = useState<string[]>([]);
  const [evidenceRefs, setEvidenceRefs] = useState<string[]>([]);
  const [sourceRunOverride, setSourceRunOverride] = useState<string | null>(null);
  const [sourceRunInput, setSourceRunInput] = useState(props.sourceRunId ?? "");
  const [format, setFormat] = useState<"playwright-ts" | "api-ts">("playwright-ts");
  const [capabilityGrantId, setCapabilityGrantId] = useState("");
  const [confirmedBy, setConfirmedBy] = useState("");

  const requestedSourceRunId = sourceRunOverride ?? props.sourceRunId ?? undefined;

  useEffect(() => {
    setSourceRunOverride(null);
    setSourceRunInput(props.sourceRunId ?? "");
  }, [props.projectId, props.sourceRunId]);

  useEffect(() => {
    let disposed = false;
    setContext(null);
    setDifferential(null);
    setAsset(null);
    setDifferentialId("");
    setAssetId("");
    setMessage("");
    setBaseRevision("");
    setHeadRevision("");
    setDataContractId("");
    setOracleSpecIds([]);
    setCoverageItemIds([]);
    setEvidenceRefs([]);
    if (!props.projectId) return undefined;
    setContextLoading(true);
    void getReliabilityAssetContext(props.projectId, requestedSourceRunId)
      .then(({ context: next }) => {
        if (disposed) return;
        setContext(next);
        setDataContractId(next.dataContracts[0]?.id ?? "");
        setOracleSpecIds(next.oracleSpecs.filter((item) => item.lifecycleStatus === "active").map((item) => item.id));
        setCoverageItemIds(next.coverageItems.map((item) => item.id));
        setEvidenceRefs(next.evidenceRefs.map((item) => item.id));
      })
      .catch((error) => { if (!disposed) setMessage(error instanceof Error ? error.message : "可靠性上下文读取失败"); })
      .finally(() => { if (!disposed) setContextLoading(false); });
    return () => { disposed = true; };
  }, [props.projectId, requestedSourceRunId]);

  const selectedContract = useMemo(
    () => context?.dataContracts.find((item) => item.id === dataContractId),
    [context, dataContractId]
  );

  function structuredDifferentialRequest() {
    if (!context || !props.projectId) throw new Error("请先选择项目并等待上下文加载");
    if (!baseRevision.trim() || !headRevision.trim()) throw new Error("请填写 Base 和 Head revision");
    if (!dataContractId || !oracleSpecIds.length) throw new Error("请至少选择一个 Data Contract 和 Oracle");
    return {
      schemaVersion: "1.0",
      organizationId: "local",
      projectId: props.projectId,
      baseRevision: baseRevision.trim(),
      headRevision: headRevision.trim(),
      plan: planFor(context),
      dataContractId,
      oracleSpecIds,
      environmentHash: context.environmentDefaults.environmentHash,
      ociImage: context.environmentDefaults.ociImage,
      browserVersion: context.environmentDefaults.browserVersion,
      randomSeed: selectedContract?.randomSeed ?? context.environmentDefaults.randomSeed,
      testTime: selectedContract?.testTime ?? context.environmentDefaults.testTime,
      idempotencyKey: `workbench-differential:${props.projectId}:${baseRevision.trim()}:${headRevision.trim()}`
    };
  }

  function structuredAssetRequest() {
    if (!context || !props.projectId || !requestedSourceRunId) throw new Error("请先选择项目和可信来源 Run");
    if (!coverageItemIds.length || !oracleSpecIds.length || !evidenceRefs.length) throw new Error("请至少选择 Coverage、Oracle 和 Evidence");
    return {
      schemaVersion: "1.0",
      projectId: props.projectId,
      sourceRunId: requestedSourceRunId,
      coverageItemIds,
      oracleSpecIds,
      evidenceRefs,
      format,
      repositoryRoot: context.repositoryRoot || props.repositoryRoot,
      repositorySha256: context.repositorySha256
    };
  }

  async function loadDifferentialById(id: string) {
    const response = await getDifferentialRun(id);
    setDifferential({ ...response.differentialRun, parentRun: response.parentRun });
    return response.differentialRun;
  }

  async function pollDifferential(id: string) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const next = await loadDifferentialById(id);
      if (terminal(next.status)
        && terminal(next.base.state)
        && terminal(next.head.state)
        && terminal(next.parentRun?.state)) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    setMessage("差分任务仍在执行，请稍后点击读取差分刷新结果。");
  }

  async function createDifferential() {
    try {
      const payload = advancedDifferential ? parsePayload(differentialRequest) : structuredDifferentialRequest();
      const response = await createDifferentialRun(payload);
      setDifferentialId(response.differentialRun.id);
      setDifferential(response.differentialRun);
      setMessage("差分任务已创建，正在等待 Base/Head 和父 Run 收尾。");
      void pollDifferential(response.differentialRun.id).catch((error) => setMessage(error instanceof Error ? error.message : "差分状态读取失败"));
    } catch (error) { setMessage(error instanceof Error ? error.message : "差分任务创建失败"); }
  }

  async function loadAssetById(id: string) {
    const response = await getTestAsset(id);
    setAsset({ value: response.asset, target: response.target, oracleSpecs: response.oracleSpecs });
  }

  async function generateAsset() {
    try {
      const payload = advancedAsset ? parsePayload(assetRequest) : structuredAssetRequest();
      const runId = typeof payload.sourceRunId === "string" && payload.sourceRunId ? payload.sourceRunId : requestedSourceRunId;
      if (!runId) throw new Error("请提供 sourceRunId");
      const response = await createTestAsset(runId, payload);
      setAssetId(response.asset.id);
      await loadAssetById(response.asset.id);
      setMessage("测试资产候选已生成。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "测试资产生成失败"); }
  }

  async function validateAsset() {
    if (!assetId.trim()) return;
    try {
      await validateTestAsset(assetId.trim(), { mutationIds: [0] });
      await loadAssetById(assetId.trim());
      setMessage("已完成三次干净环境重复运行和定向 Mutation 验证。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "测试资产验证失败"); }
  }

  async function applyAsset() {
    if (!assetId.trim() || !asset) return;
    try {
      if (!capabilityGrantId.trim() || !confirmedBy.trim()) throw new Error("需要 Capability Grant 和确认人");
      const response = await applyTestAsset(assetId.trim(), {
        capabilityGrantId: capabilityGrantId.trim(),
        confirmedBy: confirmedBy.trim(),
        expectedRepositorySha256: asset.target.repositorySha256
      });
      await loadAssetById(assetId.trim());
      setMessage(`已写入新分支 ${response.branch}，没有自动 commit 或 push。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "测试资产写入失败"); }
  }

  function toggle(values: string[], value: string, setter: (next: string[]) => void) {
    setter(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  }

  return (
    <section className="storage-box reliability-assets-box" aria-label="可信验收与测试资产">
      <h3>可信验收 · 测试资产</h3>
      <p className="integrity-note">上下文会随当前项目和 Run 自动刷新；只有高级模式需要手工编辑 JSON。</p>
      {!props.projectId ? <p className="integrity-note">请选择项目后开始。</p> : null}
      {props.projectId ? <div className="connector-grid reliability-source-run-picker">
        <label>可信来源 Run ID<input value={sourceRunInput} onChange={(event) => setSourceRunInput(event.target.value)} placeholder="run_…" /></label>
        <button type="button" onClick={() => setSourceRunOverride(sourceRunInput.trim() || null)} disabled={!sourceRunInput.trim()}>载入来源 Run</button>
      </div> : null}
      {contextLoading ? <p className="integrity-note">正在读取项目、Oracle、Coverage、Evidence 和仓库哈希…</p> : null}
      {context ? (
        <>
          <p className="integrity-note">项目 {context.projectId} · 来源 Run {context.sourceRunId ?? "未选择"} · worktree hash {context.repositorySha256.slice(0, 12)}…</p>
          <details className="reliability-operation-form" open>
            <summary>创建差分任务</summary>
            <div className="connector-grid">
              <label>Base revision<input value={baseRevision} onChange={(event) => setBaseRevision(event.target.value)} placeholder="commit / tag" /></label>
              <label>Head revision<input value={headRevision} onChange={(event) => setHeadRevision(event.target.value)} placeholder="commit / tag" /></label>
              <label>Data Contract<select value={dataContractId} onChange={(event) => setDataContractId(event.target.value)}><option value="">选择 Data Contract</option>{context.dataContracts.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.dataSourceKinds.join(", ")}</option>)}</select></label>
            </div>
            <fieldset><legend>Oracle</legend>{context.oracleSpecs.length ? context.oracleSpecs.map((item) => <label key={item.id}><input type="checkbox" checked={oracleSpecIds.includes(item.id)} onChange={() => toggle(oracleSpecIds, item.id, setOracleSpecIds)} />{item.description} · {item.source.kind}</label>) : <span>暂无 Oracle</span>}</fieldset>
            <label><input type="checkbox" checked={advancedDifferential} onChange={(event) => setAdvancedDifferential(event.target.checked)} />高级 JSON</label>
            {advancedDifferential ? <textarea value={differentialRequest} onChange={(event) => setDifferentialRequest(event.target.value)} rows={8} aria-label="差分请求 JSON" placeholder="粘贴完整 DifferentialRunV1 请求" /> : null}
            <button type="button" onClick={() => void createDifferential()}>创建并执行 Base/Head</button>
          </details>
          <details className="reliability-operation-form">
            <summary>生成和验证测试资产</summary>
            <label>生成格式<select value={format} onChange={(event) => setFormat(event.target.value as "playwright-ts" | "api-ts")}><option value="playwright-ts">Playwright E2E</option><option value="api-ts">API TS</option></select></label>
            <fieldset><legend>Coverage</legend>{context.coverageItems.length ? context.coverageItems.map((item) => <label key={item.id}><input type="checkbox" checked={coverageItemIds.includes(item.id)} onChange={() => toggle(coverageItemIds, item.id, setCoverageItemIds)} />{item.module} · {item.surface} · {item.risk}</label>) : <span>当前 Run 暂无 Coverage</span>}</fieldset>
            <fieldset><legend>Evidence</legend>{context.evidenceRefs.map((item) => <label key={item.id}><input type="checkbox" checked={evidenceRefs.includes(item.id)} onChange={() => toggle(evidenceRefs, item.id, setEvidenceRefs)} />{item.title}</label>)}</fieldset>
            <label><input type="checkbox" checked={advancedAsset} onChange={(event) => setAdvancedAsset(event.target.checked)} />高级 JSON</label>
            {advancedAsset ? <textarea value={assetRequest} onChange={(event) => setAssetRequest(event.target.value)} rows={8} aria-label="测试资产请求 JSON" placeholder="粘贴完整 TestAssetV1 请求" /> : null}
            <div className="connector-grid"><button type="button" onClick={() => void generateAsset()}>生成 TypeScript 候选</button><button type="button" onClick={() => void validateAsset()} disabled={!assetId.trim()}>验证 3 次 + Mutation</button></div>
            <label>Capability Grant ID<input value={capabilityGrantId} onChange={(event) => setCapabilityGrantId(event.target.value)} /></label>
            <label>确认人<input value={confirmedBy} onChange={(event) => setConfirmedBy(event.target.value)} /></label>
            <button type="button" onClick={() => void applyAsset()} disabled={!asset?.value.validation || asset.value.status !== "ready-for-review"}>安全写入新分支</button>
          </details>
        </>
      ) : null}
      <div className="connector-grid">
        <label>Differential Run ID<input value={differentialId} onChange={(event) => setDifferentialId(event.target.value)} placeholder="diff_…" /></label>
        <button type="button" onClick={() => void loadDifferentialById(differentialId.trim())} disabled={!differentialId.trim()}>读取差分</button>
        <label>Test Asset ID<input value={assetId} onChange={(event) => setAssetId(event.target.value)} placeholder="asset_…" /></label>
        <button type="button" onClick={() => void loadAssetById(assetId.trim())} disabled={!assetId.trim()}>读取资产</button>
      </div>
      {message ? <p className="run-error" role="alert">{message}</p> : null}
      {differential ? <article className="integrity-list"><header><strong>{differential.id}</strong><span>{differential.status}</span></header><p>Parent <code>{differential.parentRun?.id ?? differential.id}</code> · {differential.parentRun?.state ?? "unknown"} · gate={differential.parentRun?.gateStatus ?? "pending"}</p><p>Base <code>{differential.base.revision}</code> · {differential.base.state} · gate={differential.base.gateStatus ?? "pending"}</p><p>Head <code>{differential.head.revision}</code> · {differential.head.state} · gate={differential.head.gateStatus ?? "pending"}</p><p>分类：<strong>{differential.pairManifest.classification ?? "inconclusive"}</strong> · {differential.pairManifest.classificationReasons.join("、") || "等待双侧证据"}</p><p>contract={differential.pairManifest.dataContractId} · plan={differential.pairManifest.planHash.slice(0, 12)}… · data={differential.pairManifest.dataHash.slice(0, 12)}… · env={differential.pairManifest.environmentHash.slice(0, 12)}…</p></article> : null}
      {asset ? <article className="integrity-list"><header><strong>{asset.value.id}</strong><span>{asset.value.status}</span></header><p>问题 Coverage：{asset.value.coverageItemIds.join(", ")} · Oracle：{asset.value.oracleSpecIds.join(", ")}</p><p>Evidence：{asset.value.evidenceRefs.join(", ")} · source run={asset.value.sourceRunId}</p>{asset.oracleSpecs?.map((oracle) => <p key={oracle.id}>Oracle {oracle.id}：{oracle.source.kind} · {oracle.decisionUse} · {oracle.description}</p>)}{asset.value.validation ? <p>重复：{asset.value.validation.passedRepetitions}/{asset.value.validation.repetitions} · Mutation：{asset.value.validation.mutationKilled}/{asset.value.validation.mutationTotal} · security={String(asset.value.validation.securityPassed)}</p> : <p>尚未完成 3 次重复和 Mutation 验证。</p>}{asset.value.files.map((file) => <details key={file.path}><summary>{file.path} · {file.language}</summary><pre>{file.content}</pre></details>)}<details><summary>Apply 前 Patch 预览 · worktree={asset.target.clean ? "clean" : "dirty"}</summary><pre>{asset.target.patch}</pre></details></article> : null}
    </section>
  );
}
