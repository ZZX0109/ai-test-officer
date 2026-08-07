import { describe, expect, it } from "vitest";
import { planRequiresLoginCredentials } from "../src/loginPlan";

describe("planRequiresLoginCredentials", () => {
  it("requests credentials for executable login actions", () => {
    expect(planRequiresLoginCredentials({
      businessFlows: [{ scenarioId: "todo_login", title: "登录后查看任务" }],
      plan: { levels: [{ paths: [{ steps: ["打开登录页", "login_as_test_user", "验证登录成功"] }] }] }
    })).toBe(true);
    expect(planRequiresLoginCredentials({
      businessFlows: [{ scenarioId: "todo_login", title: "登录后查看任务", steps: ["打开页面"] }]
    })).toBe(true);
  });

  it("does not request credentials for unrelated permission wording", () => {
    expect(planRequiresLoginCredentials({
      businessFlows: [{ title: "未登录访问权限提示", reason: "验证访客不能访问受保护页面" }],
      plan: { levels: [{ paths: [{ steps: ["打开页面", "验证访问被拒绝"] }] }] }
    })).toBe(false);
  });

  it("recognizes structured action objects", () => {
    expect(planRequiresLoginCredentials({ steps: [{ action: "sign_in", title: "进入账户" }] })).toBe(true);
  });
});
