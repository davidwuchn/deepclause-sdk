.PHONY: all clean test lint install release

all: test

clean:
	find . -name "*.pyc" -delete
	find . -name "__pycache__" -delete
	rm -rf build/ dist/ *.egg-info

test:
	pytest -v

lint:
	pycodestyle autopep8.py

install:
	pip install -e .

install-test:
	pip install -e ".[test]"

release: clean
	python -m build
	twine upload dist/*
