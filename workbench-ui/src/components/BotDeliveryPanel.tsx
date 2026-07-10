import { Send } from "lucide-react";
import type { BotDelivery } from "../types";

interface BotDeliveryPanelProps {
  provider: NonNullable<BotDelivery["provider"]>;
  channel: string;
  recipients: string;
  githubPrUrl: string;
  includeScreenshots: boolean;
  deliveries: BotDelivery[];
  disabled?: boolean;
  onProviderChange: (value: NonNullable<BotDelivery["provider"]>) => void;
  onChannelChange: (value: string) => void;
  onRecipientsChange: (value: string) => void;
  onGithubPrUrlChange: (value: string) => void;
  onIncludeScreenshotsChange: (value: boolean) => void;
  onDeliver: () => void;
}

export function BotDeliveryPanel({
  provider,
  channel,
  recipients,
  githubPrUrl,
  includeScreenshots,
  deliveries,
  disabled,
  onProviderChange,
  onChannelChange,
  onRecipientsChange,
  onGithubPrUrlChange,
  onIncludeScreenshotsChange,
  onDeliver
}: BotDeliveryPanelProps) {
  return (
    <section className="bot-box">
      <h3>机器人推送</h3>
      <div className="connector-grid">
        <label>
          Provider
          <select value={provider} onChange={(event) => onProviderChange(event.target.value as NonNullable<BotDelivery["provider"]>)}>
            <option value="simulated">simulated</option>
            <option value="wecom">wecom</option>
            <option value="feishu">feishu</option>
            <option value="slack">slack</option>
            <option value="github_pr_comment">github_pr_comment</option>
            <option value="generic">generic</option>
          </select>
        </label>
        <label>
          Channel
          <input value={channel} onChange={(event) => onChannelChange(event.target.value)} />
        </label>
        <label>
          Recipients
          <input value={recipients} onChange={(event) => onRecipientsChange(event.target.value)} />
        </label>
        <label>
          GitHub PR URL
          <input value={githubPrUrl} onChange={(event) => onGithubPrUrlChange(event.target.value)} placeholder="仅 github_pr_comment 需要" />
        </label>
        <label className="checkbox-row">
          <input
            checked={includeScreenshots}
            onChange={(event) => onIncludeScreenshotsChange(event.target.checked)}
            type="checkbox"
          />
          失败时带截图引用
        </label>
      </div>
      <button type="button" disabled={disabled} onClick={onDeliver}>
        <Send size={15} />
        推送最近运行
      </button>
      <div className="delivery-list">
        {deliveries.slice(0, 3).map((delivery) => (
          <article key={delivery.id}>
            <header>
              <strong>{delivery.provider ?? "simulated"}</strong>
              <span>{delivery.status}</span>
            </header>
            <p>{delivery.channel} · blocked={String(delivery.blockedRelease ?? false)}</p>
            {delivery.payloadSummary ? <code>{delivery.payloadSummary}</code> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
