import { useEffect, useState } from "react";
import { getRunReviewCase } from "../api";
import type { ReviewCase } from "../types";

export function useReviewCase(runId: string | null, enabled: boolean) {
  const [reviewCase, setReviewCase] = useState<ReviewCase | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!runId || !enabled) { setReviewCase(null); return () => { cancelled = true; }; }
    void getRunReviewCase(runId).then((data) => { if (!cancelled) setReviewCase(data.reviewCase); }).catch(() => { if (!cancelled) setReviewCase(null); });
    return () => { cancelled = true; };
  }, [runId, enabled]);
  return reviewCase;
}
