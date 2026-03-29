import pytest
from project.main import Stack


def test_push_and_pop():
    s = Stack()
    s.push(1)
    s.push(2)
    assert s.pop() == 2
    assert s.pop() == 1


def test_peek():
    s = Stack()
    s.push(42)
    assert s.peek() == 42
    assert s.pop() == 42


def test_is_empty():
    s = Stack()
    assert s.is_empty() is True
    s.push(1)
    assert s.is_empty() is False


def test_pop_empty_raises():
    s = Stack()
    with pytest.raises(IndexError):
        s.pop()


def test_peek_empty_raises():
    s = Stack()
    with pytest.raises(IndexError):
        s.peek()
