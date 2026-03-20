import os
import sys
import subprocess
import time
import argparse
import psutil

def kill_server_by_port(port: int):
    """通过端口号查找并杀掉进程。"""
    found = False
    for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
        try:
            # 检查连接
            conns = proc.connections(kind='inet')
            for conn in conns:
                if conn.laddr.port == port:
                    print(f"发现正占用端口 {port} 的进程: PID {proc.pid} ({proc.name()})")
                    proc.terminate()
                    proc.wait(timeout=5)
                    print(f"已停止旧进程 PID {proc.pid}。")
                    found = True
                    break
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.TimeoutExpired):
            continue
    if not found:
        print(f"未发现占用端口 {port} 的进程。")

def start_server():
    """启动后端服务。"""
    # 假设在项目根目录运行
    script_path = os.path.join("backend", "server.py")
    if not os.path.exists(script_path):
        print(f"错误: 找不到 {script_path}")
        return

    print(f"正在启动后端服务: {script_path} ...")
    # 使用与系统环境一致的 python 解释器
    try:
        # 使用 Popen 后台运行
        subprocess.Popen([sys.executable, script_path], 
                         cwd=os.getcwd(),
                         creationflags=subprocess.CREATE_NEW_CONSOLE if os.name == 'nt' else 0)
        print("后端服务已在后台启动。")
    except Exception as e:
        print(f"启动失败: {e}")

def main():
    parser = argparse.ArgumentParser(description="重启 LEGO CAD 仿真后端服务。")
    parser.add_argument("--port", type=int, default=8000, help="后端服务占用的端口号 (默认: 8000)")
    
    args = parser.parse_args()

    print("=== 重启后端服务 ===")
    kill_server_by_port(args.port)
    # 给系统一点释放端口的时间
    time.sleep(1)
    start_server()
    print("====================")

if __name__ == "__main__":
    main()
