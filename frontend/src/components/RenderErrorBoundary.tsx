import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onCatch?: (error: Error) => void;
}

interface State {
  hasError: boolean;
}

/**
 * 宏观治理组件：渲染错误边界
 * 用于隔离 3D 渲染各子系统的崩溃风险，防止单个模型加载失败拖垮整个 Canvas。
 */
export class RenderErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(_: Error): State {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, _errorInfo: ErrorInfo) {
    if (this.props.onCatch) {
        this.props.onCatch(error);
    } else {
        console.warn("[RenderErrorBoundary] Caught rendering error:", error);
    }
  }

  public render() {
    if (this.state.hasError) {
      return this.props.fallback || null;
    }

    return this.props.children;
  }
}
