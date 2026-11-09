from PyQt6.QtCore import QThread, pyqtSignal


class Job(QThread):
    """Herhangi bir fonksiyonu arka planda çalıştırır; arayüz donmaz."""
    done = pyqtSignal(object)
    failed = pyqtSignal(str)

    def __init__(self, fn, *args, **kwargs):
        super().__init__()
        self.fn, self.args, self.kwargs = fn, args, kwargs

    def run(self):
        try:
            self.done.emit(self.fn(*self.args, **self.kwargs))
        except Exception as e:
            self.failed.emit(str(e))


class JobRunner:
    """Çalışan işleri tutar (Python çöp toplayıcısı silmesin diye)."""

    def __init__(self):
        self.jobs = set()

    def run(self, fn, *args, on_done=None, on_fail=None, **kwargs):
        job = Job(fn, *args, **kwargs)
        if on_done:
            job.done.connect(on_done)
        if on_fail:
            job.failed.connect(on_fail)
        self.jobs.add(job)
        job.finished.connect(lambda: self.jobs.discard(job))
        job.start()
        return job

    def wait_all(self, ms=8000):
        for j in list(self.jobs):
            j.wait(ms)
