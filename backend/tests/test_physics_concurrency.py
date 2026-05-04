"""
test_physics_concurrency.py — L55 PhysicsEngine 锁与 asyncio.to_thread 集成回归
==============================================================================
PyBullet 单 client 在多线程下访问会触发 C++ 内部 UB（典型表现为段错误 / 状态损坏）。
本测试验证 backend/physics_engine.py 给所有公有方法加的 self._lock 真的串行了访问，
并确认 server.py 用 asyncio.to_thread 跑 step 时主事件循环不被冻结。
"""
from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.physics_engine import PhysicsEngine  # noqa: E402


class TestEngineLocking(unittest.TestCase):
    """多线程同时 hammer engine 不能引发异常 / 段错误（pybullet UB 防御）。"""

    def test_concurrent_step_state_force_is_safe(self):
        engine = PhysicsEngine(mode="DIRECT")
        try:
            errors: list[BaseException] = []

            def worker_step() -> None:
                try:
                    for _ in range(300):
                        engine.step()
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)

            def worker_state() -> None:
                try:
                    for _ in range(300):
                        engine.get_state()
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)

            def worker_force() -> None:
                try:
                    for _ in range(300):
                        # robot_id is None — apply_user_force 会早返回，但仍走锁
                        engine.apply_user_force("base_link", [0.0, 0.0, 0.1])
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)

            threads: list[threading.Thread] = []
            for fn in (worker_step, worker_state, worker_force):
                for _ in range(3):
                    threads.append(threading.Thread(target=fn))
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            self.assertEqual(errors, [], msg=f"并发访问触发异常: {errors}")
        finally:
            engine.disconnect()

    def test_reset_during_active_workers_serializes_safely(self):
        """reset() 在另一线程正活跃 step 时调用，不能让任何一边崩。"""
        engine = PhysicsEngine(mode="DIRECT")
        try:
            stop_flag = threading.Event()
            errors: list[BaseException] = []

            def worker() -> None:
                try:
                    while not stop_flag.is_set():
                        engine.step()
                        engine.get_state()
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)

            t = threading.Thread(target=worker)
            t.start()
            try:
                time.sleep(0.05)
                # 在 worker 正频繁拿锁时 reset() ——必须靠锁串行化，反之会让 worker 拿到
                # 已 disconnect 的旧 client_id 进而 segfault
                engine.reset("DIRECT")
                time.sleep(0.05)
                engine.reset("DIRECT")  # 二连发也得稳
                time.sleep(0.05)
            finally:
                stop_flag.set()
                t.join()

            self.assertEqual(errors, [], msg=f"reset 期间 worker 崩了: {errors}")
        finally:
            engine.disconnect()


class TestAsyncIoIntegration(unittest.TestCase):
    """关键 L55 回归：相对断言 —— to_thread 比同步调用给 asyncio 更多 yield 机会。

    绝对阈值容易因 PyBullet 是否在 stepSimulation 内释 GIL 而漂移；改成对比同
    一负载下 sync vs to_thread 的 yielder tick 数，断言 to_thread 显著占优即可。
    这是 Option A 的核心收益：HTTP 路由 / 其他 ws / idem 中间件不再被物理 burst
    完全冻结，哪怕 pybullet 不释 GIL，asyncio 也至少能在 step 之间穿插。
    """

    @staticmethod
    def _measure_ticks(stepper_factory, duration_s: float = 0.2) -> int:
        """跑一个 yielder + 一个 stepper，返回 yielder 在窗口内 tick 的次数。"""
        ticks = 0

        async def main() -> None:
            nonlocal ticks

            async def yielder() -> None:
                nonlocal ticks
                deadline = time.monotonic() + duration_s
                while time.monotonic() < deadline:
                    await asyncio.sleep(0.005)
                    ticks += 1

            await asyncio.gather(yielder(), stepper_factory())

        asyncio.run(main())
        return ticks

    def test_to_thread_lets_asyncio_run_more_than_sync_blocking(self):
        engine = PhysicsEngine(mode="DIRECT")
        try:
            # 同样的物理负载，同样的 200ms 窗口，跑两次：
            # - sync：直接在协程里同步 burst（asyncio 主循环被完全冻住）
            # - to_thread：burst 挪到 executor 线程
            async def stepper_sync() -> None:
                for _ in range(8):
                    engine.step_n(200)

            async def stepper_to_thread() -> None:
                for _ in range(8):
                    await asyncio.to_thread(engine.step_n, 200)

            # 跑多次取均值降噪 —— 单次 OS 调度抖动可能让对比反向，3 次取均值稳得多
            sync_avg = sum(self._measure_ticks(stepper_sync) for _ in range(3)) / 3
            thread_avg = sum(self._measure_ticks(stepper_to_thread) for _ in range(3)) / 3

            # 只要求 thread 路径有显著绝对优势（至少多 5 tick）。不强求倍数 ——
            # PyBullet 在 stepSimulation 内部持 GIL 决定上限；本地实测 ~14 vs ~22。
            # 真正归零（thread <= sync）才说明 to_thread 完全无效，这才是 L55 要防的回归。
            self.assertGreaterEqual(
                thread_avg, sync_avg + 5,
                msg=(
                    f"to_thread 没明显改善：sync_avg={sync_avg:.1f}, "
                    f"thread_avg={thread_avg:.1f}（期望至少 +5 tick）"
                ),
            )
        finally:
            engine.disconnect()


if __name__ == "__main__":
    unittest.main()
