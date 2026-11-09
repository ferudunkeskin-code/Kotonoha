import json
from ..paths import CURRICULUM_PATH


class Curriculum:
    def __init__(self, path=CURRICULUM_PATH):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self.levels = data["levels"]
        self.steps = data["steps"]
        self.units = {}
        self.order = []
        for lv in self.levels:
            for u in lv["units"]:
                u = dict(u, level_id=lv["id"], level_title=lv["title_tr"], jlpt=lv["jlpt"])
                self.units[u["id"]] = u
                self.order.append(u["id"])

    def unit(self, unit_id):
        return self.units[unit_id]

    def step_ids(self):
        return [s["id"] for s in self.steps]

    def step(self, step_id):
        return next(s for s in self.steps if s["id"] == step_id)

    def next_unit(self, completed: dict):
        """Henüz tamamlanmamış ilk ünite."""
        for uid in self.order:
            if uid not in completed:
                return uid
        return None
