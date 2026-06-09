"""Build SWE-bench instance Docker images for the given dataset and instance IDs."""
import json
import os
import sys

import docker
from datasets import load_dataset
from swebench.harness.docker_build import build_instance_images


def main():
    dataset_name = sys.argv[1]
    split = sys.argv[2]
    namespace = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "none" else None
    max_workers = int(sys.argv[4]) if len(sys.argv) > 4 else 4
    instance_ids_path = sys.argv[5] if len(sys.argv) > 5 else None

    ds = load_dataset(dataset_name, split=split)

    if instance_ids_path:
        with open(instance_ids_path) as f:
            instance_ids = set(json.load(f))
        filtered = [row for row in ds if row["instance_id"] in instance_ids]
    elif os.environ.get("INSTANCE_IDS"):
        instance_ids = set(json.loads(os.environ["INSTANCE_IDS"]))
        filtered = [row for row in ds if row["instance_id"] in instance_ids]
    else:
        filtered = list(ds)

    print(f"Building images for {len(filtered)} instances from {dataset_name}")

    client = docker.from_env()
    successful, failed = build_instance_images(
        client, filtered, max_workers=max_workers,
        namespace=namespace, tag="latest", env_image_tag="latest",
    )
    print(f"Built {len(successful)} instance images, {len(failed)} failed")
    if failed:
        for exc in failed:
            print(f"  FAILED: {exc}", file=sys.stderr)

    if len(successful) == 0 and len(filtered) > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
