.PHONY: run build deploy test

run:
	@npm run dev

build:
	@npm run build

deploy:
	@npm run deploy

test:
	@npm run typecheck
	@npm test
