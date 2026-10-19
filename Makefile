SHELL := /bin/bash
.PHONY: setup up tour check status down reset

setup:   ## download the Ferrum repositories and install packages
	scripts/fetch.sh
up:      ## start database, Redis, API, worker and a test receiver
	. scripts/env.sh && $$STACK up
tour:    ## the guided tour (all steps); or: scripts/tour.sh 2
	scripts/tour.sh
check:   ## the 13-point end-to-end check
	. scripts/env.sh && $$PY workspace/infra/tests/smoke.py --base $$GW
status:
	. scripts/env.sh && $$STACK status
down:
	. scripts/env.sh && $$STACK down
reset:   ## stop and delete all data
	. scripts/env.sh && $$STACK reset
