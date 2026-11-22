"""贪吃蛇游戏（pygame）。

逻辑层 Game 不依赖 pygame，便于单元测试；pygame 仅在 run() 中按需导入。

操作：方向键 / WASD 移动，R 重新开始（游戏结束后），ESC 退出。
"""
from __future__ import annotations

import random

GRID_W = 20
GRID_H = 20
CELL = 24
FPS = 10
POINTS_PER_FOOD = 10

UP = (0, -1)
DOWN = (0, 1)
LEFT = (-1, 0)
RIGHT = (1, 0)
OPPOSITE = {UP: DOWN, DOWN: UP, LEFT: RIGHT, RIGHT: LEFT}


class Game:
    """纯逻辑的贪吃蛇状态机。坐标 (x, y)，蛇头为 snake[0]。"""

    def __init__(self, width: int = GRID_W, height: int = GRID_H, rng: random.Random | None = None):
        if width < 4 or height < 4:
            raise ValueError("棋盘至少 4x4")
        self.width = width
        self.height = height
        self.rng = rng or random.Random()
        self.reset()

    def reset(self) -> None:
        cx, cy = self.width // 2, self.height // 2
        self.snake: list[tuple[int, int]] = [(cx, cy), (cx - 1, cy), (cx - 2, cy)]
        self.direction = RIGHT
        self.pending_direction = RIGHT
        self.score = 0
        self.game_over = False
        self.food = self._spawn_food()

    def _spawn_food(self) -> tuple[int, int] | None:
        occupied = set(self.snake)
        free = [
            (x, y)
            for x in range(self.width)
            for y in range(self.height)
            if (x, y) not in occupied
        ]
        if not free:
            return None
        return self.rng.choice(free)

    def set_direction(self, d: tuple[int, int]) -> bool:
        """请求转向。禁止直接掉头（相对于当前帧实际移动方向）。返回是否接受。"""
        if self.game_over or d not in OPPOSITE:
            return False
        if d == OPPOSITE[self.direction]:
            return False
        self.pending_direction = d
        return True

    def step(self) -> None:
        """推进一帧：移动、吃食物计分、或碰撞结束。"""
        if self.game_over:
            return
        self.direction = self.pending_direction
        hx, hy = self.snake[0]
        dx, dy = self.direction
        nxt = (hx + dx, hy + dy)

        ate = nxt == self.food
        # 未吃食物时蛇尾会同步移动，因此尾部格子不算碰撞
        body = self.snake if ate else self.snake[:-1]
        out_of_bounds = not (0 <= nxt[0] < self.width and 0 <= nxt[1] < self.height)
        if out_of_bounds or nxt in body:
            self.game_over = True
            return

        self.snake.insert(0, nxt)
        if ate:
            self.score += POINTS_PER_FOOD
            self.food = self._spawn_food()
            if self.food is None:  # 棋盘被占满，视为通关结束
                self.game_over = True
        else:
            self.snake.pop()

    @property
    def length(self) -> int:
        return len(self.snake)


def run(max_frames: int = 0) -> int:
    """启动 pygame 窗口循环。max_frames>0 时运行指定帧数后退出（用于无显示冒烟测试）。返回已运行帧数。"""
    import pygame  # 延迟导入

    pygame.init()
    game = Game()
    screen = pygame.display.set_mode((GRID_W * CELL, GRID_H * CELL + 40))
    pygame.display.set_caption("贪吃蛇")
    clock = pygame.time.Clock()
    font = pygame.font.Font(None, 26)

    keymap = {
        pygame.K_UP: UP, pygame.K_w: UP,
        pygame.K_DOWN: DOWN, pygame.K_s: DOWN,
        pygame.K_LEFT: LEFT, pygame.K_a: LEFT,
        pygame.K_RIGHT: RIGHT, pygame.K_d: RIGHT,
    }

    frames = 0
    running = True
    try:
        while running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                elif event.type == pygame.KEYDOWN:
                    if event.key in keymap:
                        game.set_direction(keymap[event.key])
                    elif event.key == pygame.K_r and game.game_over:
                        game.reset()
                    elif event.key == pygame.K_ESCAPE:
                        running = False

            game.step()
            draw(pygame, screen, font, game)
            pygame.display.flip()
            clock.tick(FPS)
            frames += 1
            if max_frames and frames >= max_frames:
                break
    finally:
        pygame.quit()
    return frames


def draw(pygame, screen, font, game: Game) -> None:
    screen.fill((20, 20, 28))
    if game.food is not None:
        fx, fy = game.food
        pygame.draw.rect(screen, (230, 70, 70), (fx * CELL, fy * CELL, CELL - 1, CELL - 1))
    for i, (x, y) in enumerate(game.snake):
        color = (80, 220, 120) if i == 0 else (40, 160, 90)
        pygame.draw.rect(screen, color, (x * CELL, y * CELL, CELL - 1, CELL - 1))

    hud = font.render(f"分数: {game.score}  长度: {game.length}", True, (240, 240, 240))
    screen.blit(hud, (8, GRID_H * CELL + 8))
    if game.game_over:
        msg = font.render("游戏结束，按 R 重新开始", True, (255, 220, 120))
        screen.blit(msg, (GRID_W * CELL // 2 - msg.get_width() // 2, GRID_H * CELL // 2))


if __name__ == "__main__":
    run()
