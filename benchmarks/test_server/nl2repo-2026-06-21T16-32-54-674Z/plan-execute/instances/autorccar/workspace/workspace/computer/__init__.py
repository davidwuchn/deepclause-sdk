"""
AutoRCCar computer package - Core autonomous driving modules.

Provides NeuralNetwork, RCControl, DistanceToCamera, ObjectDetection,
Server, VideoStreamHandler, SensorDataHandler, and CollectTrainingData.
"""

# Re-export core classes for convenient imports
from .model import NeuralNetwork, load_data
from .rc_driver_helper import RCControl, DistanceToCamera, ObjectDetection
from .rc_driver import Server, VideoStreamHandler, SensorDataHandler
from .collect_training_data import CollectTrainingData

__all__ = [
    'NeuralNetwork', 'load_data',
    'RCControl', 'DistanceToCamera', 'ObjectDetection',
    'Server', 'VideoStreamHandler', 'SensorDataHandler',
    'CollectTrainingData',
]
