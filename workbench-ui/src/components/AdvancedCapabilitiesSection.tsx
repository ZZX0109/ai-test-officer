import { CalendarClock, Send, Square, Timer } from "lucide-react";
import { AuthenticatedArtifactLink } from "./AuthenticatedArtifact";
import { BenchmarkPanel } from "./BenchmarkPanel";
import { BotDeliveryPanel } from "./BotDeliveryPanel";
import { DiscoveryPanel } from "./DiscoveryPanel";
import { HistoryPanel } from "./HistoryPanel";
import { PatrolPanel } from "./PatrolPanel";
import { StoragePanel } from "./StoragePanel";
import type {
  BenchmarkSummary,
  BotDelivery,
  DiscoveryScanResult,
  ExecutableTestPlan,
  GrayPlan,
  HarnessGap,
  HarnessGapScenarioDraft,
  PatrolJob,
  PatrolTrend,
  RunHistoryEntry,
  RunResult,
  StorageArchive,
  StorageStatus,
  PlatformCapability
} from "../types";

interface AdvancedCapabilitiesSectionProps {
  discovery: DiscoveryScanResult | null;
  scenarioDrafts: HarnessGapScenarioDraft[];
  onScan: () => void;
  onProbeDraft: (id: string) => void;
  onApproveDraft: (id: string) => void;
  isPatrolling: boolean;
  onRunPatrolOnce: () => void;
  isScheduling: boolean;
  onStartScheduler: () => void;
  onStopScheduler: () => void;
  result: RunResult | null;
  onDeliverRun: () => void;
  botProvider: NonNullable<BotDelivery["provider"]>;
  botChannel: string;
  notifyList: string;
  botGithubPrUrl: string;
  botIncludeScreenshots: boolean;
  deliveries: BotDelivery[];
  onBotProviderChange: (value: NonNullable<BotDelivery["provider"]>) => void;
  onBotChannelChange: (value: string) => void;
  onNotifyListChange: (value: string) => void;
  onBotGithubPrUrlChange: (value: string) => void;
  onBotIncludeScreenshotsChange: (value: boolean) => void;
  patrolJobs: PatrolJob[];
  patrolPlans: PatrolJob[];
  patrolTrend: PatrolTrend | null;
  onRunSavedPatrolPlan: (id: string) => void;
  onRemoveSavedPatrolPlan: (id: string) => void;
  storageStatus: StorageStatus | null;
  storageArchives: StorageArchive[];
  onRunRetentionDryRun: () => void;
  benchmarkSummary: BenchmarkSummary | null;
  runHistory: RunHistoryEntry[];
  onOpenHistoricalRun: (id: string) => void;
  capabilities: PlatformCapability[];
  activeExecutablePlan?: ExecutableTestPlan;
  harnessGaps: HarnessGap[];
  gapDrafts: Record<string, HarnessGapScenarioDraft>;
  onDraftScenarioFromGap: (gap: HarnessGap) => void;
  onInstallScenarioFromGap: (gap: HarnessGap) => void;
  onSetGapStatus: (gap: HarnessGap, status: "dismissed") => void;
  plan: GrayPlan | null;
}

export function AdvancedCapabilitiesSection({
  discovery, scenarioDrafts, onScan, onProbeDraft, onApproveDraft, isPatrolling,
  onRunPatrolOnce, isScheduling, onStartScheduler, onStopScheduler, result,
  onDeliverRun, botProvider, botChannel, notifyList, botGithubPrUrl,
  botIncludeScreenshots, deliveries, onBotProviderChange, onBotChannelChange,
  onNotifyListChange, onBotGithubPrUrlChange, onBotIncludeScreenshotsChange,
  patrolJobs, patrolPlans, patrolTrend, onRunSavedPatrolPlan, onRemoveSavedPatrolPlan,
  storageStatus, storageArchives, onRunRetentionDryRun, benchmarkSummary, runHistory,
  onOpenHistoricalRun, capabilities, activeExecutablePlan, harnessGaps, gapDrafts,
  onDraftScenarioFromGap, onInstallScenarioFromGap, onSetGapStatus, plan
}: AdvancedCapabilitiesSectionProps) {
  return (
          <details className="advanced-section">
            <summary>
              <span>
                <strong>高级能力与运行细节</strong>
                <small>Discovery、巡检、推送、存储和完整计划</small>
              </span>
            </summary>
            <div className="advanced-stack">
              <DiscoveryPanel
                discovery={discovery}
                drafts={scenarioDrafts}
                onScan={onScan}
                onProbeDraft={onProbeDraft}
                onApproveDraft={onApproveDraft}
              />

              <div className="compact-action-row">
                <button disabled={isPatrolling} onClick={onRunPatrolOnce} type="button">
                  <CalendarClock size={16} />
                  {isPatrolling ? "巡检中" : "巡检一次"}
                </button>
                <button disabled={isScheduling} onClick={onStartScheduler} type="button">
                  <Timer size={16} />
                  启动定时
                </button>
                <button disabled={isScheduling} onClick={onStopScheduler} type="button">
                  <Square size={16} />
                  停止定时
                </button>
                <button disabled={!result} onClick={onDeliverRun} type="button">
                  <Send size={16} />
                  推送值班
                </button>
              </div>

              <BotDeliveryPanel
                provider={botProvider}
                channel={botChannel}
                recipients={notifyList}
                githubPrUrl={botGithubPrUrl}
                includeScreenshots={botIncludeScreenshots}
                deliveries={deliveries}
                disabled={!result}
                onProviderChange={onBotProviderChange}
                onChannelChange={onBotChannelChange}
                onRecipientsChange={onNotifyListChange}
                onGithubPrUrlChange={onBotGithubPrUrlChange}
                onIncludeScreenshotsChange={onBotIncludeScreenshotsChange}
                onDeliver={onDeliverRun}
              />

              <PatrolPanel
                patrolJobs={patrolJobs}
                patrolPlans={patrolPlans}
                trend={patrolTrend}
                onRunPlan={onRunSavedPatrolPlan}
                onDeletePlan={onRemoveSavedPatrolPlan}
              />

              <StoragePanel storage={storageStatus} archives={storageArchives} onDryRunRetention={onRunRetentionDryRun} />
              <BenchmarkPanel summary={benchmarkSummary} />
              <HistoryPanel runs={runHistory} activeRunId={result?.id} onOpenRun={onOpenHistoricalRun} />

              <section className="capability-grid">
                <h3>平台能力映射</h3>
                {capabilities.map((capability) => (
                  <article key={capability.id}>
                    <header>
                      <strong>{capability.title}</strong>
                      <span>{capability.status}</span>
                    </header>
                    <p>{capability.purpose}</p>
                    <code>{capability.demoAction}</code>
                  </article>
                ))}
              </section>

              {activeExecutablePlan && (
                <section className="levels">
                  <h3>Executable Plan Contract</h3>
                  <article className={activeExecutablePlan.status === "valid" ? "passed" : "warning"}>
                    <strong>{activeExecutablePlan.id}</strong>
                    <p>{activeExecutablePlan.source} · {activeExecutablePlan.status} · steps={activeExecutablePlan.steps.length}</p>
                  </article>
                  {activeExecutablePlan.steps.map((step) => (
                    <article className="level" key={step.id}>
                      <header>
                        <strong>{step.title}</strong>
                        <span>{step.scenarioId}</span>
                      </header>
                      <p>assertions: {step.assertions.join(", ")}</p>
                      <p>evidence: {step.evidenceRequirements.join(", ")}</p>
                    </article>
                  ))}
                </section>
              )}

              <section className="harness-gap-box">
                <h3>Harness Gaps</h3>
                {harnessGaps.slice().reverse().slice(0, 6).map((gap) => {
                  const draft = gapDrafts[gap.id];
                  return (
                    <article key={gap.id} className={`gap ${gap.status}`}>
                      <header>
                        <strong>{gap.missingScenarioTitle}</strong>
                        <span>{gap.status}</span>
                      </header>
                      <p>{gap.requirementSummary}</p>
                      <p>验证条件：{gap.suggestedOracle}</p>
                      <code>{gap.requiredCapabilities.join(", ")}</code>
                      {draft && (
                        <div className="draft-box">
                          <strong>{draft.scenarioId}</strong>
                          <span>review={draft.draftReviewStatus ?? "draft"} · probe={draft.selectorProbeStatus ?? "not_run"}</span>
                          {draft.missingInfo?.length ? <span>missing: {draft.missingInfo.join(", ")}</span> : null}
                          {draft.scenarioFile && (
                            <AuthenticatedArtifactLink artifactUrl={draft.scenarioFile}>
                              打开草案
                            </AuthenticatedArtifactLink>
                          )}
                          {draft.installedFile && <span>installed: {draft.installedFile}</span>}
                        </div>
                      )}
                      <div className="row-actions">
                        <button type="button" onClick={() => onDraftScenarioFromGap(gap)}>生成草案</button>
                        <button type="button" onClick={() => onInstallScenarioFromGap(gap)}>探测并批准入库</button>
                        <button type="button" onClick={() => onSetGapStatus(gap, "dismissed")}>忽略</button>
                      </div>
                    </article>
                  );
                })}
                {harnessGaps.length === 0 && <p className="empty">暂无未覆盖 harness gap。</p>}
              </section>

              <section className="risk-list">
                <h3>风险清单</h3>
                {plan?.risks.map((risk) => (
                  <article key={risk.id} className={`risk ${risk.level}`}>
                    <span>{risk.level}</span>
                    <div>
                      <strong>{risk.title}</strong>
                      <p>{risk.evidence}</p>
                    </div>
                  </article>
                ))}
              </section>

              <section className="levels">
                <h3>显式灰度层级</h3>
                {plan?.levels.map((level) => (
                  <article className="level" key={level.id}>
                    <header>
                      <strong>{level.title}</strong>
                      <span>{level.id}</span>
                    </header>
                    <p>{level.description}</p>
                    {level.paths.map((path) => (
                      <details key={path.id} open={level.id === "core_path"}>
                        <summary>{path.title}</summary>
                        <ol>
                          {path.steps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                      </details>
                    ))}
                  </article>
                ))}
              </section>
            </div>
          </details>

  );
}
