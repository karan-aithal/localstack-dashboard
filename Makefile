.PHONY: install run dev test check

# a shell set up for other tools (ROS, for example) must not leak its Python packages in
export PYTHONPATH :=

install:
	cd backend && uv sync
	cd web && npm install

run:  ## build the UI, then serve everything on http://localhost:8080
	cd web && npm run build
	cd backend && uv run uvicorn app.main:app --host 127.0.0.1 --port 8080

dev:  ## backend on 127.0.0.1:8080, UI on http://localhost:5180
	@trap 'kill 0' INT TERM EXIT; \
	(cd backend && uv run uvicorn app.main:app --host 127.0.0.1 --port 8080 --reload) & \
	(cd web && npm run dev) & \
	wait

test:
	cd backend && uv run python -m pytest -q
	cd web && npm test

check: test
	cd web && npm run build
