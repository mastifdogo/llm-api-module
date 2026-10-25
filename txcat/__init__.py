"""txcat: recommend bookkeeping categories for statement transactions using an LLM."""

from .categorizer import Categorizer
from .models import Suggestion, Transaction

__all__ = ["Categorizer", "Suggestion", "Transaction"]
__version__ = "0.1.0"
