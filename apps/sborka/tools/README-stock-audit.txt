Stock audit tool

Purpose:
- explain why employee inventory did not go back to zero after a finished WB supply or OZ assembly
- show what moved in, what moved out, what still sits on employees, and where bypass/fix caused a mismatch

Usage:
- node tools/audit-employee-stock.mjs wb WB-GI-227837807
- node tools/audit-employee-stock.mjs oz ozon-1775034942151-c51b21
- node tools/audit-employee-stock.mjs wb WB-GI-227837807 --json

What it checks:
- employee sessions for the entity
- pick items and bypass/fix cases
- scan issues
- sklad movements:
  - wb_pick_scan / wb_collect
  - oz_pick_scan / oz_collect
- current employee inventory in sklad
- warehouse negative shelf count for the active FBS warehouse

Main signals:
- "Bypass item ... inbound movement is 0"
- "writeoff exceeds inbound"
- "Finished employee still has net ..."
- "Employee inventory still has ..., but entity net is already zero"
- "movements were written to product code ..."
