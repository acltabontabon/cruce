# Two-writer convergence fixture

The baseline schedules a request using a shared millisecond timeout. Writer A
changes that value to seconds and updates the existing request consumer. Writer B
independently adds a retry consumer assuming milliseconds, with a two-second
behavioral assertion. Both branches pass their complete tests. Their disjoint
patches merge cleanly, but the merged retry waits 2 ms instead of 2,000 ms.

The repair explicitly converts seconds to milliseconds without changing the test.
All scheduling is injected and captured synchronously; no timers or network calls
are used. The shared verification driver runs this fixture through ordinary Git
and Cruce's existing publication, evidence, review and promotion boundaries.
