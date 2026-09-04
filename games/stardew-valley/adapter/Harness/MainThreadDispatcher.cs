using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace StardewAgentMod.Harness;

internal sealed class MainThreadDispatcher
{
    private readonly ConcurrentQueue<IWorkItem> pending = new();

    public Task<T> InvokeAsync<T>(Func<T> action, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(action);
        cancellationToken.ThrowIfCancellationRequested();
        var item = new WorkItem<T>(action, cancellationToken);
        this.pending.Enqueue(item);
        return item.Task;
    }

    public void Drain()
    {
        while (this.pending.TryDequeue(out IWorkItem? item))
            item.Execute();
    }

    public void CancelPending(string reason)
    {
        while (this.pending.TryDequeue(out IWorkItem? item))
            item.Cancel(reason);
    }

    private interface IWorkItem
    {
        void Execute();
        void Cancel(string reason);
    }

    private sealed class WorkItem<T> : IWorkItem
    {
        private readonly Func<T> action;
        private readonly CancellationToken cancellationToken;
        private readonly TaskCompletionSource<T> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public WorkItem(Func<T> action, CancellationToken cancellationToken)
        {
            this.action = action;
            this.cancellationToken = cancellationToken;
        }

        public Task<T> Task => this.completion.Task;

        public void Execute()
        {
            if (this.cancellationToken.IsCancellationRequested)
            {
                this.completion.TrySetCanceled(this.cancellationToken);
                return;
            }

            try
            {
                this.completion.TrySetResult(this.action());
            }
            catch (Exception ex)
            {
                this.completion.TrySetException(ex);
            }
        }

        public void Cancel(string reason)
        {
            this.completion.TrySetException(new OperationCanceledException(reason));
        }
    }
}
