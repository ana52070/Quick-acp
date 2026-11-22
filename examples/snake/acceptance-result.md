# 贪吃蛇项目技术验收报告

## 1. 验收范围

| 文件 | 说明 | 本次是否改动 |
|------|------|--------------|
| `snake.py` | 游戏实现（逻辑层 `Game` + pygame 渲染层 `run()` / `draw()`） | 否（只读） |
| `test_snake.py` | 纯逻辑层单元测试，共 17 项 | 否（只读） |
| `acceptance-result.md` | 本验收报告 | 新建 |

## 2. 架构设计

- **逻辑和渲染分开**：`Game` 类完全不依赖 pygame，`pygame` 只在 `run()` 里按需导入，所以单元测试不用装显示环境。
- **随机数可以注入**：构造函数接收 `rng: random.Random`，测试传入固定种子，结果可复现。
- **常量配置**：棋盘 `GRID_W x GRID_H = 20 x 20`，格子大小 `CELL = 24` 像素，`FPS = 10`，每吃一个食物得 `POINTS_PER_FOOD = 10` 分。
- **冒烟测试入口**：`run(max_frames)` 在 `max_frames > 0` 时跑完指定帧数就退出，并返回实际帧数，可以配合 `SDL_VIDEODRIVER=dummy` 在没有显示器的环境里验证。

## 3. 核心逻辑

### 3.1 状态

- `snake`：坐标列表，`snake[0]` 是蛇头；初始为棋盘中心向左排的 3 节。
- `direction` / `pending_direction`：当前帧实际移动方向和下一帧准备用的方向（双缓冲）。
- `score`、`game_over`、`food`（棋盘被占满时为 `None`）。

### 3.2 转向规则（`set_direction`）

- 游戏结束后或方向不合法（不是 4 个单位向量之一）时拒绝。
- 掉头判断以**当前帧实际移动方向 `direction`** 为准，不看 `pending_direction`。这样同一帧里连按两次键（例如先 UP 再 LEFT）也不会掉头 180° 撞到自己。

### 3.3 每帧推进（`step`）

1. 把 `pending_direction` 提交为 `direction`，算出新蛇头位置 `nxt`。
2. 碰撞检测：出界，或撞到蛇身就结束游戏。**没吃到食物时，尾巴这一帧会同时移开，所以尾格不算碰撞。**
3. 吃到食物：长度 +1，得分 +10，在空格子里重新生成食物；没有空格子时算通关，游戏结束。
4. 没吃到食物：头部前进一格，尾部弹出一格，长度不变。

### 3.4 关键代码示例

```python
ate = nxt == self.food
# 未吃食物时蛇尾会同步移动，因此尾部格子不算碰撞
body = self.snake if ate else self.snake[:-1]
out_of_bounds = not (0 <= nxt[0] < self.width and 0 <= nxt[1] < self.height)
if out_of_bounds or nxt in body:
    self.game_over = True
    return
```

## 4. 测试覆盖（17 项）

| 测试类 | 项数 | 覆盖点 |
|--------|------|--------|
| `TestInit` | 3 | 棋盘太小时报错、初始状态、食物落在空格子 |
| `TestMovement` | 5 | 前进且长度不变、拒绝掉头、接受垂直转向、拒绝非法向量、转向在 step 时生效 |
| `TestFood` | 2 | 吃食物后变长并得分、食物在空格子重新生成 |
| `TestCollision` | 5 | 撞墙、撞自己、可以移入正在离开的尾格、结束后不能再操作、占满棋盘算通关 |
| `TestReset` | 1 | 重置后恢复初始状态 |
| `TestSameTickReversal` | 1 | 回归测试：同一帧连按两次键不能掉头 |

## 5. 验收命令

```bash
# 单元测试（预期 17 项全部通过）
python -m unittest test_snake.py

# pygame dummy 5 帧冒烟测试（预期输出 SMOKE_OK: 5）
python -c "import os; os.environ['SDL_VIDEODRIVER'] = 'dummy'; import snake; frames = snake.run(5); print(f'SMOKE_OK: {frames}')"
```

> 实际运行结果见本次验收会话的总结。
