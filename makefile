.PHONY: run agent build test

run:
	@go run .

agent:
	@cd agent && npm start

build:
	go build -o glav .

test:
	go test .
	cd agent && npm run typecheck && npm test
