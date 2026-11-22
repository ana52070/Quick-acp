'''snake.py 的单元测试（仅测试纯逻辑层 Game，不需要 pygame）。

运行方式：python -m unittest -v test_snake
'''
import random
import unittest

from snake import DOWN, LEFT, POINTS_PER_FOOD, RIGHT, UP, Game


def make_game(width=10, height=10, seed=0):
    return Game(width, height, rng=random.Random(seed))


class TestInit(unittest.TestCase):
    def test_board_too_small_raises(self):
        with self.assertRaises(ValueError):
            Game(3, 10)
        with self.assertRaises(ValueError):
            Game(10, 3)

    def test_initial_state(self):
        g = make_game()
        self.assertEqual(g.snake, [(5, 5), (4, 5), (3, 5)])
        self.assertEqual(g.direction, RIGHT)
        self.assertEqual(g.score, 0)
        self.assertFalse(g.game_over)
        self.assertEqual(g.length, 3)

    def test_food_is_on_free_cell(self):
        for seed in range(20):
            g = make_game(seed=seed)
            self.assertIsNotNone(g.food)
            self.assertNotIn(g.food, g.snake)
            self.assertTrue(0 <= g.food[0] < g.width and 0 <= g.food[1] < g.height)


class TestMovement(unittest.TestCase):
    def test_step_moves_head_forward_and_keeps_length(self):
        g = make_game()
        g.food = (9, 9)
        g.step()
        self.assertEqual(g.snake, [(6, 5), (5, 5), (4, 5)])
        self.assertEqual(g.length, 3)
        self.assertFalse(g.game_over)

    def test_set_direction_rejects_reversal(self):
        g = make_game()
        self.assertFalse(g.set_direction(LEFT))
        self.assertEqual(g.pending_direction, RIGHT)

    def test_set_direction_accepts_perpendicular(self):
        g = make_game()
        self.assertTrue(g.set_direction(UP))
        self.assertEqual(g.pending_direction, UP)

    def test_set_direction_rejects_invalid_vector(self):
        g = make_game()
        self.assertFalse(g.set_direction((2, 0)))
        self.assertFalse(g.set_direction((0, 0)))

    def test_direction_applies_on_step(self):
        g = make_game()
        g.food = (9, 9)
        g.set_direction(DOWN)
        g.step()
        self.assertEqual(g.snake[0], (5, 6))
        self.assertEqual(g.direction, DOWN)


class TestFood(unittest.TestCase):
    def test_eating_grows_snake_and_scores(self):
        g = make_game()
        g.food = (6, 5)
        g.step()
        self.assertEqual(g.score, POINTS_PER_FOOD)
        self.assertEqual(g.length, 4)
        self.assertEqual(g.snake[0], (6, 5))
        self.assertNotIn(g.food, g.snake)

    def test_food_respawns_on_free_cell_after_eating(self):
        g = make_game(seed=3)
        g.food = (6, 5)
        g.step()
        self.assertIsNotNone(g.food)
        self.assertNotIn(g.food, g.snake)


class TestCollision(unittest.TestCase):
    def test_wall_collision_ends_game(self):
        g = make_game(width=5, height=5)
        g.snake = [(4, 2), (3, 2), (2, 2)]
        g.direction = g.pending_direction = RIGHT
        g.food = (0, 0)
        g.step()
        self.assertTrue(g.game_over)

    def test_self_collision_ends_game(self):
        g = make_game()
        # 头 (5,5) 向左移动到 (4,5)，而 (4,5) 是蛇身，应判定碰撞
        g.snake = [(5, 5), (5, 6), (4, 6), (4, 5), (4, 4), (5, 4), (6, 4), (6, 5)]
        g.direction = g.pending_direction = LEFT
        g.food = (0, 0)
        g.step()
        self.assertTrue(g.game_over)

    def test_moving_into_vacating_tail_is_allowed(self):
        g = make_game()
        # 2x2 环：头 (1,1) 向右移动到原尾部 (2,1)，尾部同时移开，不算碰撞
        g.snake = [(1, 1), (1, 2), (2, 2), (2, 1)]
        g.direction = g.pending_direction = RIGHT
        g.food = (0, 0)
        g.step()
        self.assertFalse(g.game_over)
        self.assertEqual(g.snake[0], (2, 1))
        self.assertEqual(g.length, 4)

    def test_no_step_after_game_over(self):
        g = make_game()
        g.game_over = True
        before = list(g.snake)
        g.step()
        self.assertEqual(g.snake, before)
        self.assertFalse(g.set_direction(UP))

    def test_board_full_ends_game(self):
        g = make_game(width=4, height=4)
        cells = [(x, y) for x in range(4) for y in range(4) if (x, y) not in ((3, 0), (2, 0))]
        g.snake = [(2, 0)] + cells  # 蛇占满除食物格外的所有格子，头在 (2,0)
        g.direction = g.pending_direction = RIGHT
        g.food = (3, 0)
        g.step()
        self.assertEqual(g.score, POINTS_PER_FOOD)
        self.assertIsNone(g.food)
        self.assertTrue(g.game_over)


class TestReset(unittest.TestCase):
    def test_reset_restores_initial_state(self):
        g = make_game()
        g.food = (6, 5)
        g.step()
        g.game_over = True
        g.reset()
        self.assertEqual(g.snake, [(5, 5), (4, 5), (3, 5)])
        self.assertEqual(g.score, 0)
        self.assertFalse(g.game_over)
        self.assertEqual(g.direction, RIGHT)


class TestSameTickReversal(unittest.TestCase):
    '''回归测试：同一帧内连续两次按键不应造成 180° 掉头（自杀）。'''

    def test_two_keys_in_one_tick_cannot_reverse(self):
        g = make_game()
        g.food = (9, 9)
        # 当前朝向 RIGHT。同一帧先按 UP（合法），再按 LEFT（相对于 RIGHT 是掉头，应被拒绝）。
        self.assertTrue(g.set_direction(UP))
        self.assertFalse(g.set_direction(LEFT))
        g.step()
        self.assertFalse(g.game_over)


if __name__ == '__main__':
    unittest.main()
