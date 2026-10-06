def evaluate(expression: str) -> float:
    cleaned = expression.replace(" ", "")
    parts = cleaned.split("+")
    return sum(float(p) for p in parts)
