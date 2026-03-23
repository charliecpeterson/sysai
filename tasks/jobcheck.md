---
description: SLURM job status and health check
auto_run:
  - squeue -u $USER --format="%.10i %.12P %.25j %.8T %.10M %.5D %R" 2>/dev/null || echo "(SLURM not available on this host)"
  - sacct -u $USER --starttime=today --format=JobID,JobName,State,ExitCode,Elapsed,NodeList -X 2>/dev/null || true
  - df -h ${SCRATCH:-$HOME} 2>/dev/null || true
---
Analyze my SLURM job status based on the output above.
Flag failed jobs, stuck pending jobs, or storage quota issues.
If SLURM is not available, say so briefly and stop.
Keep the response short — only highlight things that need attention.
