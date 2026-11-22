# pygame 贪吃蛇

需要 Python 3.10 及以上。

```powershell
python -m pip install -r requirements.txt
python snake.py
```

方向键或 WASD 转向，游戏结束后按 R 重新开始，ESC 退出。吃食物得10分，撞墙或身体结束，填满棋盘通关。

## 自动验证

```powershell
python -m unittest -v test_snake
$env:SDL_VIDEODRIVER='dummy'
$env:SDL_AUDIODRIVER='dummy'
python -c "import snake; assert snake.run(max_frames=5)==5; print('PYGAME_SMOKE_PASS')"
```

逻辑测试覆盖17个场景：初始化、移动、转向、同帧禁止掉头、食物生成、增长计分、墙壁与身体碰撞、移入即将离开的尾部、棋盘填满和重新开始。图形冒烟测试验证pygame初始化、事件循环、绘制和退出。

此目录由Codeg内Quick-acp实际读取父项目并调用文件工具创建，主代理补齐验收、修复同帧转向及Windows字体枚举兼容问题。完整ACP工具闭环结果以父项目端到端验收记录为准。
