import { CircleAlert } from "lucide-react";
import type { ReviewCase } from "../types";

export function ReviewCasePanel({ reviewCase }: { reviewCase: ReviewCase | null }) {
  if (!reviewCase) return null;
  return (
    <section className={`review-case-panel review-case-panel--${reviewCase.severity}`} aria-label="人工审核原因">
      <div className="review-case-panel__title"><CircleAlert size={16} /><strong>{reviewCase.title}</strong><span>{reviewCase.category}</span></div>
      <p>{reviewCase.explanation}</p>
      <dl><dt>系统已做</dt><dd>{reviewCase.whatWasTried.join(" ")}</dd><dt>下一步</dt><dd>{reviewCase.nextAction}</dd></dl>
      {reviewCase.evidenceRefs.length ? <small>关联证据：{reviewCase.evidenceRefs.join(", ")}</small> : null}
    </section>
  );
}
