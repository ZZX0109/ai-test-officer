import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type TaskStatus = "active" | "completed";
type Filter = "all" | TaskStatus;

interface Task {
  id: number;
  title: string;
  status: TaskStatus;
}

const APP_API_URL = import.meta.env.VITE_APP_API_URL ?? "http://localhost:6172";
const ENABLE_TASK_FILTER_FIXTURE_BUG = import.meta.env.VITE_TASK_FILTER_FIXTURE_BUG === "1";
const FIXTURE_VARIANT_ID = new URLSearchParams(window.location.search).get("fixtureVariantId");
const VIEWER_PERMISSION_FIXTURE_BUG = FIXTURE_VARIANT_ID === "fxv_d10a7e1c4b298f63";
const SEARCH_SELECTOR_DRIFT_FIXTURE = FIXTURE_VARIANT_ID === "fxv_9c4d0a73e1b625f8";
const TEST_USER = "qa.officer@example.com";

async function fetchTasks(status: Filter, keyword: string, forceError: boolean): Promise<Task[]> {
  const params = new URLSearchParams();
  const shouldDropStatusForFixtureBug = ENABLE_TASK_FILTER_FIXTURE_BUG && status === "completed";
  if (forceError) {
    params.set("status", "error");
  } else if (status !== "all" && !shouldDropStatusForFixtureBug) {
    params.set("status", status);
  }
  if (keyword.trim()) {
    params.set("keyword", keyword.trim());
  }
  const query = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${APP_API_URL}/api/tasks${query}`);
  if (!response.ok) {
    throw new Error(`任务接口失败：${response.status}`);
  }
  const data = (await response.json()) as { tasks: Task[] };
  return data.tasks;
}

function App() {
  const [filter, setFilter] = useState<Filter>("all");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<TaskStatus>("active");
  const [searchDraft, setSearchDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [forceError, setForceError] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [loginError, setLoginError] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchTasks(filter, keyword, forceError)
      .then((items) => {
        if (!cancelled) setTasks(items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "任务接口失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, keyword, forceError, refreshToken]);

  const counts = useMemo(() => {
    return tasks.reduce(
      (acc, task) => {
        acc[task.status] += 1;
        return acc;
      },
      { active: 0, completed: 0 }
    );
  }, [tasks]);

  function addTask(event: React.FormEvent) {
    event.preventDefault();
    if (!isAuthenticated) {
      setValidationError("请先登录后再新增任务");
      return;
    }
    if (!title.trim()) {
      setValidationError("请输入任务标题");
      return;
    }
    setValidationError("");
    setTasks((current) => [
      { id: Date.now(), title: title.trim(), status },
      ...current
    ]);
    setTitle("");
  }

  function markTaskCompleted(id: number) {
    setTasks((current) =>
      current.map((task) => task.id === id ? { ...task, status: "completed" } : task)
    );
  }

  function editTaskTitle(id: number) {
    setTasks((current) =>
      current.map((task) => task.id === id ? { ...task, title: "准备答辩材料（已编辑）" } : task)
    );
  }

  function logout() {
    setLoginError("");
    setIsAuthenticated(false);
  }

  function loginTestUser() {
    setLoginError("");
    setIsAuthenticated(true);
  }

  function loginInvalidUser() {
    setLoginError("账号或密码错误");
    setIsAuthenticated(false);
  }

  function runSearch(event: React.FormEvent) {
    event.preventDefault();
    setForceError(false);
    setFilter("all");
    setKeyword(searchDraft.trim());
  }

  function chooseFilter(value: Filter) {
    setForceError(false);
    setFilter(value);
  }

  function simulateError() {
    setForceError(true);
  }

  function retryAfterError() {
    setForceError(false);
    setRefreshToken((current) => current + 1);
  }

  return (
    <main className="shell">
      <section className="header">
        <div>
          <p className="eyebrow">App Under Test</p>
          <h1>任务管理系统</h1>
        </div>
        <div className="auth-card" aria-label="登录权限">
          <strong data-testid="auth-state">
            {isAuthenticated ? `已登录 ${TEST_USER}` : "未登录访客"}
          </strong>
          <span>{isAuthenticated ? "可新增、筛选、变更任务状态" : "需要测试账号登录后才能操作任务"}</span>
          {isAuthenticated ? (
            <button type="button" onClick={logout}>退出登录</button>
          ) : (
            <div className="auth-actions">
              <button type="button" onClick={loginTestUser}>登录测试账号</button>
              <button type="button" onClick={loginInvalidUser}>错误账号登录</button>
            </div>
          )}
          {loginError && <span className="auth-error" data-testid="login-error">{loginError}</span>}
        </div>
        <div className="metrics" aria-label="任务统计">
          <span><i aria-hidden="true" className="metric-icon active" />进行中 {counts.active}</span>
          <span><i aria-hidden="true" className="metric-icon completed" />已完成 {counts.completed}</span>
        </div>
      </section>

      <section className="toolbar" aria-label="任务筛选">
        {[
          ["all", "全部"],
          ["active", "进行中"],
          ["completed", "已完成"]
        ].map(([value, label]) => (
          <button
            key={value}
            className={filter === value ? "active" : ""}
            onClick={() => chooseFilter(value as Filter)}
            type="button"
          >
            <i aria-hidden="true" />
            {label}
          </button>
        ))}
        <button className={forceError ? "active danger" : "danger"} onClick={simulateError} type="button">
          <i aria-hidden="true" />
          模拟错误
        </button>
      </section>

      <form className="search-form" onSubmit={runSearch}>
        <input
          aria-label={SEARCH_SELECTOR_DRIFT_FIXTURE ? "查找工作项" : "搜索任务"}
          data-testid="task-search-input"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          placeholder="搜索任务关键字"
        />
        <button type="submit">搜索</button>
      </form>

      <form className="task-form" onSubmit={addTask}>
        <input
          aria-label="新任务标题"
          data-testid="new-task-title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            if (validationError) setValidationError("");
          }}
          placeholder="新增测试任务"
        />
        <select
          aria-label="新任务状态"
          value={status}
          onChange={(event) => setStatus(event.target.value as TaskStatus)}
        >
          <option value="active">进行中</option>
          <option value="completed">已完成</option>
        </select>
        <button disabled={!isAuthenticated} type="submit">新增</button>
      </form>
      {validationError && <p className="validation" data-testid="title-error">{validationError}</p>}

      <section className="task-list" data-testid="task-list">
        {!isAuthenticated && (
          <p className="state locked" data-testid="permission-state">{VIEWER_PERMISSION_FIXTURE_BUG ? "权限状态未知" : "请先登录测试账号"}</p>
        )}
        {loading && <p className="state">加载中...</p>}
        {error && (
          <div className="state error" data-testid="error-state">
            <p>{error}</p>
            <button type="button" onClick={retryAfterError}>重试</button>
          </div>
        )}
        {!isAuthenticated && !loading && !error ? null : !loading && !error && tasks.length === 0 && (
          <p className="state" data-testid="empty-state">暂无任务</p>
        )}
        {isAuthenticated &&
          !loading &&
          !error &&
          tasks.map((task) => (
            <article className="task-row" key={task.id}>
              <div>
                <h2 data-testid="task-title">{task.title}</h2>
                <p data-testid={task.id === 1 ? "task-1-status" : "task-status"}>status={task.status}</p>
              </div>
              <span className={`badge ${task.status}`}>
                <i aria-hidden="true" />
                {task.status === "active" ? "进行中" : "已完成"}
              </span>
              {task.status === "active" && (
                <>
                  <button type="button" onClick={() => editTaskTitle(task.id)}>
                    编辑{task.title}
                  </button>
                  <button type="button" onClick={() => markTaskCompleted(task.id)}>
                    标记{task.title}为已完成
                  </button>
                </>
              )}
            </article>
          ))}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
