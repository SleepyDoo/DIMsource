import ErrorPanel from 'app/shell/ErrorPanel';
import { errorLog } from 'app/utils/log';
import React, { Component } from 'react';
import { reportException } from '../utils/exceptions';

interface Props {
  name: string;
  children?: React.ReactNode;
}

interface State {
  error?: Error;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {};
  }

  componentDidCatch(error: Error, errorInfo: { componentStack: string }) {
    const { name } = this.props;

    this.setState({ error });
    errorLog(name, error, errorInfo);
    reportException(name, error, errorInfo);
  }

  render() {
    const { error } = this.state;
    const { children } = this.props;

    if (error) {
      return <ErrorPanel error={error} />;
    }
    return children;
  }
}
