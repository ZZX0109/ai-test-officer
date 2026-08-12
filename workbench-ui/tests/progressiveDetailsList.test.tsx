import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LazyDetails, ProgressiveDetailsList } from "../src/components/ProgressiveDetailsList";

describe("ProgressiveDetailsList", () => {
  it("keeps the full inventory while mounting it in bounded batches", () => {
    const items = Array.from({ length: 55 }, (_, index) => ({ id: `flow-${index + 1}` }));

    render(
      <ProgressiveDetailsList
        items={items}
        itemKey={(item) => item.id}
        initialCount={20}
        batchSize={20}
        summary="全部 55 条"
        renderItem={(item) => <article>{item.id}</article>}
      />
    );

    expect(screen.getByText("flow-20")).toBeTruthy();
    expect(screen.queryByText("flow-21")).toBeNull();
    expect(screen.getByText("已显示 20/55 条")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "再显示 20 条" }));

    expect(screen.getByText("flow-40")).toBeTruthy();
    expect(screen.queryByText("flow-41")).toBeNull();
    expect(screen.getByText("已显示 40/55 条")).toBeTruthy();
  });

  it("does not mount path details until they are expanded", () => {
    const view = render(
      <LazyDetails summary="查看代码依据">
        <p>expensive path evidence</p>
      </LazyDetails>
    );

    expect(view.queryByText("expensive path evidence")).toBeNull();
    const details = view.getByText("查看代码依据").parentElement as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle", { bubbles: true }));
    expect(view.getByText("expensive path evidence")).toBeTruthy();
  });
});
