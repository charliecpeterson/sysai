---
description: System health check — disk, memory, load, failed services
auto_run:
  - uptime
  - df -h 2>/dev/null
  - free -h 2>/dev/null || vm_stat 2>/dev/null || true
  - systemctl --failed --no-pager 2>/dev/null || true
---
Check the health of this system based on the output above.
Flag any real issues with disk space, memory pressure, high load, or failed services.
Be concise — only mention things that actually need attention.
