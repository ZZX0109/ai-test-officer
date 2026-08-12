import React, { useEffect, useMemo, useState } from "react";

interface LazyDetailsProps {
  summary: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  defaultOpen?: boolean;
}

/** Mounts potentially large detail payloads only while the section is open. */
export function LazyDetails({ summary, children, className, defaultOpen = false }: LazyDetailsProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {open ? children : null}
    </details>
  );
}

interface ProgressiveDetailsListProps<T> {
  items: readonly T[];
  itemKey: (item: T) => React.Key;
  renderItem: (item: T, index: number) => React.ReactNode;
  summary: React.ReactNode;
  className?: string;
  listClassName?: string;
  listTag?: "div" | "ol" | "ul";
  initialCount?: number;
  batchSize?: number;
  defaultOpen?: boolean;
  /** Server-side inventories may have more items than the pages currently in
   * memory. `onLoadMore` fetches the next page instead of mounting data that
   * was already transferred. */
  totalCount?: number;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void | Promise<void>;
  loadMoreLabel?: (remaining: number, batchSize: number) => string;
}

/**
 * Keeps large planning inventories out of the DOM until the user asks for
 * them. The complete item array stays in application state; this component
 * only controls how much of it is mounted at once.
 */
export function ProgressiveDetailsList<T>({
  items,
  itemKey,
  renderItem,
  summary,
  className,
  listClassName,
  listTag = "div",
  initialCount = 24,
  batchSize = 24,
  defaultOpen = true,
  totalCount,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  loadMoreLabel = (remaining, nextBatch) => `再显示 ${Math.min(remaining, nextBatch)} 条`
}: ProgressiveDetailsListProps<T>) {
  const [open, setOpen] = useState(defaultOpen);
  const [visibleCount, setVisibleCount] = useState(initialCount);
  const firstKey = items.length > 0 ? String(itemKey(items[0])) : "";
  const lastKey = items.length > 0 ? String(itemKey(items[items.length - 1])) : "";

  useEffect(() => {
    setVisibleCount(initialCount);
  }, [firstKey, initialCount, items.length, lastKey]);

  const visibleItems = useMemo(
    () => open ? items.slice(0, visibleCount) : [],
    [items, open, visibleCount]
  );
  const availableRemaining = Math.max(0, items.length - visibleItems.length);
  const serverRemaining = Math.max(0, (totalCount ?? items.length) - items.length);
  const remaining = availableRemaining + serverRemaining;
  const ListTag = listTag;

  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {open ? (
        <>
          <ListTag className={listClassName} data-visible-count={visibleItems.length}>
            {visibleItems.map((item, index) => (
              <React.Fragment key={itemKey(item)}>{renderItem(item, index)}</React.Fragment>
            ))}
          </ListTag>
          {remaining > 0 ? (
            <div className="progressive-list-footer">
              <span>已显示 {visibleItems.length}/{totalCount ?? items.length} 条</span>
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => {
                  if (availableRemaining > 0) {
                    setVisibleCount((current) => Math.min(items.length, current + batchSize));
                    return;
                  }
                  void onLoadMore?.();
                }}
              >
                {loadingMore ? "正在加载…" : hasMore && availableRemaining === 0 ? `加载更多 ${Math.min(serverRemaining, batchSize)} 条` : loadMoreLabel(remaining, batchSize)}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </details>
  );
}
