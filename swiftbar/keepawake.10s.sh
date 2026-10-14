#!/bin/bash
# Shows whether anything is keeping this Mac awake right now.
# State comes from pmset only. The icon stays honest even if a plugin misbehaves.
# What raises these states is the opencode plugin keep-awake.ts.
# The number in the file name is the refresh period.

export PATH=/usr/bin:/bin:/usr/sbin:/sbin

lid_blocked=$(pmset -g | awk '/SleepDisabled/ {print $2}')
idle_blocked=$(pmset -g assertions | grep -ci caffeinate)

release="bash=/usr/bin/sudo param1=-n param2=/usr/bin/pmset param3=disablesleep param4=0 terminal=false refresh=true"

if [ "$lid_blocked" = "1" ]; then
  echo "● | color=#ff9500"
  echo "---"
  echo "Closed lid and idle sleep are blocked | color=#ff9500"
  echo "Release the closed lid now | $release"
elif [ "$idle_blocked" -gt 0 ]; then
  echo "● | color=#30b0c7"
  echo "---"
  echo "Idle sleep is blocked. A closed lid will still sleep. | color=#30b0c7"
else
  echo "○ | color=#8e8e93"
  echo "---"
  echo "Nothing is keeping this Mac awake"
fi

echo "---"
echo "Show every assertion | bash=/usr/bin/pmset param1=-g param2=assertions terminal=true"
