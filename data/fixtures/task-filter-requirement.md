# 任务状态筛选验收标准

用户在任务列表页点击“已完成”时，系统必须只展示 `status=completed` 的任务，并且接口请求需要携带 `status=completed` 查询参数。点击“进行中”时只展示 `status=active` 的任务。点击“全部”时展示全部任务。

